/**
 * 对话回滚（Rewind）—— Host 半。
 *
 * 给 Harness 补上「回到我发过的某条消息」：把模型可见的上下文截断回那一刻，
 * 并把工作区文件恢复成那一刻的样子。
 *
 * 两件事分别靠两个官方原语完成，都不改官方代码：
 *
 * 1. 上下文截断：session 日志表面（surface）的**区段替换**。官方 compaction 就是用
 *    `session.append(type, data, { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs })`
 *    把一段历史换成一条摘要。我们沿用同一机制，但替换成一条**内容为空的 user/message**：
 *    表面上的位置被占住（日志保持 append-only、可持久化、可重放），而
 *    `deriveEventMessage` 会把它派生出来 —— 各家适配器对「空 user 消息」的处理不同，
 *    DeepSeek 适配器（dsh-llm-deepseek）会直接跳过（`if (message.role === "user" &&
 *    content.length === 0) continue`），于是模型上下文恰好停在回滚点之前；若适配器不过滤，
 *    可用 `keepMessage` 让它改为携带该消息原文（见下）。
 *    原始事件仍留在日志里（轨迹视图可见），只是不再进入模型上下文 —— 所以**上下文回滚不可逆**。
 *
 * 2. 文件回滚：本插件自己的「用户消息边界快照」。每条真人消息（source.kind === 'user'
 *    且带 rpcId）落地时，给工作区拍一份内容寻址的快照（sha1 分桶存 blob + 清单 JSON），
 *    回滚时按清单把改动写回、把新建的文件删掉。纯 node:* 实现，不依赖 git。
 *
 * Client 半（`client.js`）通过下面几条同源路由驱动：
 *
 *   GET  /rewind/points       列出当前会话可回滚的消息与快照状态
 *   POST /rewind/apply        执行回滚（上下文 + 文件）
 *   POST /rewind/undo-files   只把文件恢复回上一次回滚前的样子
 *
 * 数据落在 $DSH_HOME/rewind/ 下（blobs 内容寻址共享 + 每会话 index.json）。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Cordis 插件名（与 cordis.patch.yml 的行 id 一致）。 */
export const name = 'rewind'
/** 需要 webServer 承载路由；会话与控制器服务按需取，取不到就降级。 */
export const inject = ['webServer']

const POINTS_PATH = '/rewind/points'
const APPLY_PATH = '/rewind/apply'
const UNDO_FILES_PATH = '/rewind/undo-files'
const STATE_VERSION = 1
/** 单条消息预览最多留多少字符（列表里只做展示）。 */
const PREVIEW_CHARS = 200
/** 增量记录里每条消息正文最多留多少字符（回滚时用来还原 keepMessage 的文本）。 */
const TEXT_LIMIT = 4000

/** 默认被跳过的目录名：快照不覆盖它们，回滚也不会动它们。 */
const DEFAULT_IGNORE_DIRS = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.gradle',
  '.mypy_cache',
  '.pytest_cache',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
]

/** 默认落盘根：$DSH_HOME/rewind。 */
function defaultRoot() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  return join(home, 'rewind')
}

/** 取一个非负整数配置，越界或非法时用默认值。 */
function int(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(Number(value)), min), max)
}

/** patch 里的 config 是裸 JSON（本插件不导出 Config schema），这里手动兜默认值。 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const root = typeof source.root === 'string' && source.root.trim() !== '' ? resolve(source.root.trim()) : defaultRoot()
  const ignoreDirs = Array.isArray(source.ignoreDirs)
    ? source.ignoreDirs.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : DEFAULT_IGNORE_DIRS
  return {
    root,
    /** false 时只回滚上下文，不动文件。 */
    restoreFiles: source.restoreFiles !== false,
    /** true 时替换节点携带该消息原文（上下文停在「这条消息刚发出」），默认撤回该消息本身。 */
    keepMessage: source.keepMessage === true,
    /** 每个会话最多保留多少个回滚点。 */
    maxPoints: int(source.maxPoints, 40, 1, 500),
    /** 单文件超过这个大小不入快照（回滚时会被列为 skipped）。 */
    maxFileBytes: int(source.maxFileBytes, 2 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    /** 单次快照最多收录多少个文件，超过就标记 complete:false（回滚时只还原、不删除）。 */
    maxFiles: int(source.maxFiles, 20_000, 1, 1_000_000),
    /** 单次快照最多收录多少字节（按文件大小累计）。 */
    maxSnapshotBytes: int(source.maxSnapshotBytes, 256 * 1024 * 1024, 1024, 8 * 1024 * 1024 * 1024),
  }
}

/** 会话 id 里可能出现路径分隔符等字符，落盘前统一换掉。 */
function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

/** 把绝对路径转成相对 cwd 的 posix 形式（清单里只存相对路径）。 */
function toPosixRelative(root, absolute) {
  const rel = relative(root, absolute)
  return sep === '/' ? rel : rel.split(sep).join('/')
}

/** 快照引擎：blob 内容寻址 + 每会话清单与回滚点索引。 */
class SnapshotStore {
  constructor(root, cfg) {
    this.root = root
    this.cfg = cfg
    this.blobRoot = join(root, 'blobs')
    this.sessionRoot = join(root, 'sessions')
  }

  /** 某会话的目录。 */
  dirFor(sessionId) {
    return join(this.sessionRoot, safeId(sessionId))
  }

  /** 某会话的 index.json（回滚点清单）。 */
  indexPath(sessionId) {
    return join(this.dirFor(sessionId), 'index.json')
  }

  /** 某个快照的 manifest.json。 */
  manifestPath(sessionId, snapshotId) {
    return join(this.dirFor(sessionId), 'snapshots', safeId(snapshotId), 'manifest.json')
  }

  /** 读取会话索引；文件缺失或损坏时给一个空索引，绝不拖垮调用方。 */
  async readIndex(sessionId) {
    const path = this.indexPath(sessionId)
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return emptyIndex(sessionId)
      const points = Array.isArray(parsed.points) ? parsed.points.filter(isPointRecord) : []
      return {
        version: STATE_VERSION,
        sessionId,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
        points,
        lastRollback: isRollbackRecord(parsed.lastRollback) ? parsed.lastRollback : undefined,
      }
    } catch {
      return emptyIndex(sessionId)
    }
  }

  /** 原子写入会话索引。 */
  async writeIndex(sessionId, index) {
    const path = this.indexPath(sessionId)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`)
    await rename(tmp, path)
  }

  /** 读取某个快照的清单。 */
  async readManifest(sessionId, snapshotId) {
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath(sessionId, snapshotId), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  /** blob 路径（按 sha1 前两位分桶）。 */
  blobPath(hash) {
    return join(this.blobRoot, hash.slice(0, 2), hash)
  }

  /** 写入一个 blob；内容相同则共享同一份。 */
  async putBlob(hash, bytes) {
    const path = this.blobPath(hash)
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, bytes, { flag: 'wx' })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }

  /** 读取一个 blob；缺失返回 undefined。 */
  async getBlob(hash) {
    try {
      return await readFile(this.blobPath(hash))
    } catch {
      return undefined
    }
  }

  /**
   * 给一个会话拍快照。
   * @param session - 实时 Session。
   * @param seq - 触发这次快照的用户消息事件序号。
   * @param cwd - 工作区绝对路径。
   * @param snapshotId - 快照目录名（默认 `s<seq>`；安全快照用 `pre-rewind-<seq>`）。
   * @returns 写入的清单摘要（供索引记录），或 undefined 表示已存在/无法快照。
   */
  async snapshot(session, seq, cwd, snapshotId = `s${seq}`) {
    const existing = await this.readManifest(session.id, snapshotId)
    if (existing !== undefined) return summarizeManifest(existing)
    // 遍历时顺手把新内容写进 blob 库：同一份内容只读一次、只存一份。
    const walked = await walkWorkspace(cwd, this.cfg, this.root, {
      onHash: async (hash, bytes) => {
        if (existsSync(this.blobPath(hash))) return
        await this.putBlob(hash, bytes)
      },
    })
    const manifest = {
      version: STATE_VERSION,
      id: snapshotId,
      sessionId: session.id,
      seq,
      cwd,
      at: Date.now(),
      complete: walked.complete,
      truncated: walked.truncated,
      skipped: walked.skipped,
      files: walked.entries.size,
      bytes: walked.bytes,
      entries: [...walked.entries.values()],
    }
    const path = this.manifestPath(session.id, snapshotId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(manifest))
    return summarizeManifest(manifest)
  }

  /** 删除某个快照目录（blob 留给之后的 GC，不动内容）。 */
  async dropSnapshot(sessionId, snapshotId) {
    await rm(join(this.dirFor(sessionId), 'snapshots', safeId(snapshotId)), { recursive: true, force: true })
  }
}

/** 空索引。 */
function emptyIndex(sessionId) {
  return { version: STATE_VERSION, sessionId, points: [], lastRollback: undefined }
}

/** 索引里一条回滚点记录的形状校验。 */
function isPointRecord(value) {
  return value !== null && typeof value === 'object' && Number.isSafeInteger(value.seq) && typeof value.at === 'number'
}

/** 索引里「上一次回滚」记录的形状校验。 */
function isRollbackRecord(value) {
  return value !== null && typeof value === 'object' && typeof value.at === 'number' && Number.isSafeInteger(value.atSeq)
}

/** 清单摘要（索引里只存摘要，正文体量太大）。 */
export function summarizeManifest(manifest) {
  return {
    id: typeof manifest.id === 'string' ? manifest.id : `s${manifest.seq}`,
    at: manifest.at,
    files: manifest.files,
    bytes: manifest.bytes,
    complete: manifest.complete !== false,
    skipped: manifest.skipped ?? { large: 0, symlink: 0, limit: 0, error: 0 },
  }
}

/** 内容 sha1。 */
function sha1(bytes) {
  return createHash('sha1').update(bytes).digest('hex')
}

/**
 * 遍历工作区，产出「相对路径 → {p,s,m,h}」清单。
 * 只收录常规文件：符号链接、忽略目录、超限文件都被跳过并计数。
 * @param cwd - 工作区绝对路径。
 * @param cfg - 已归一化的配置。
 * @param storeRoot - 插件自己的存储根（若在 cwd 内需要排除）。
 * @param options - `shouldHash(p, info, rel)` 决定某个文件是否要读出来算 sha1（默认都算）；
 *   `onHash(hash, bytes)` 在算完时回调（快照路径用它顺手写 blob，避免二次读盘）。
 * @returns 清单条目、跳过计数与总量。
 */
async function walkWorkspace(cwd, cfg, storeRoot, options = {}) {
  const shouldHash = options.shouldHash ?? (() => true)
  const onHash = options.onHash
  const entries = new Map()
  const skipped = { large: 0, symlink: 0, limit: 0, error: 0 }
  let bytes = 0
  let truncated = false
  const ignore = new Set(cfg.ignoreDirs)
  const storeInside = storeRoot !== undefined && isInside(cwd, storeRoot)

  /** 深度优先遍历一个目录。 */
  async function visit(dir) {
    if (truncated) return
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      skipped.error += 1
      return
    }
    for (const dirent of dirents) {
      if (truncated) return
      const absolute = join(dir, dirent.name)
      if (dirent.isSymbolicLink()) {
        skipped.symlink += 1
        continue
      }
      if (dirent.isDirectory()) {
        if (ignore.has(dirent.name)) continue
        if (storeInside && isInside(storeRoot, absolute)) continue
        await visit(absolute)
        continue
      }
      if (!dirent.isFile()) continue
      if (entries.size >= cfg.maxFiles) {
        truncated = true
        skipped.limit += 1
        return
      }
      let info
      try {
        info = await stat(absolute)
      } catch {
        skipped.error += 1
        continue
      }
      if (info.size > cfg.maxFileBytes) {
        skipped.large += 1
        continue
      }
      if (bytes + info.size > cfg.maxSnapshotBytes) {
        truncated = true
        skipped.limit += 1
        return
      }
      const p = toPosixRelative(cwd, absolute)
      const entry = { p, s: info.size, m: Math.trunc(info.mtimeMs), h: undefined }
      if (shouldHash(p, info)) {
        try {
          const content = await readFile(absolute)
          entry.h = sha1(content)
          if (onHash !== undefined) await onHash(entry.h, content)
        } catch {
          skipped.error += 1
          continue
        }
      }
      entries.set(p, entry)
      bytes += info.size
    }
  }

  await visit(cwd)
  return { entries, skipped, bytes, complete: !truncated && skipped.error === 0, truncated }
}

/** parent 是否包含 child（含相等）。 */
export function isInside(parent, child) {
  const from = resolve(parent)
  const to = resolve(child)
  if (from === to) return true
  const withSep = from.endsWith(sep) ? from : `${from}${sep}`
  return to.startsWith(withSep)
}

/**
 * 把工作区恢复成某个快照的样子。
 *
 * 判定用「stat 相同即未变、stat 不同再比 sha1」：既要准，也不能在回滚时把整个
 * 工作区读一遍（清单本身只有几十 KB～几 MB）。
 * @param store - 快照引擎。
 * @param manifest - 目标快照清单。
 * @param cfg - 已归一化配置。
 * @returns 还原/删除/未处理三份清单与告警。
 */
async function restoreManifest(store, manifest, cfg) {
  const cwd = manifest.cwd
  const wanted = new Map(manifest.entries.map((entry) => [entry.p, entry]))
  // 只有清单里存在的文件才需要算哈希：不在清单里的文件注定要被删掉。
  const current = await walkWorkspace(cwd, cfg, store.root, {
    shouldHash: (p, info) => {
      const target = wanted.get(p)
      if (target === undefined || target.h === undefined) return false
      return info.size !== target.s || Math.trunc(info.mtimeMs) !== target.m
    },
  })
  const restored = []
  const deleted = []
  const skipped = []
  const warnings = []

  for (const entry of manifest.entries) {
    // 清单损坏（没有哈希）时既比不了也取不出内容：记一笔跳过，不动这个文件。
    if (typeof entry.h !== 'string' || typeof entry.p !== 'string') {
      skipped.push(String(entry?.p ?? '?'))
      continue
    }
    const now = current.entries.get(entry.p)
    // stat 一致，或内容哈希一致 → 这个文件没变过。
    if (now !== undefined && (now.h === undefined || now.h === entry.h)) continue
    const bytes = await store.getBlob(entry.h)
    if (bytes === undefined) {
      skipped.push(entry.p)
      continue
    }
    const absolute = resolve(cwd, entry.p)
    try {
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, bytes)
      restored.push(entry.p)
    } catch (error) {
      skipped.push(entry.p)
      warnings.push(`还原 ${entry.p} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 快照之后新建的文件要删掉 —— 只有清单完整时才敢删，否则会误删没被记录的文件。
  if (manifest.complete === false) {
    warnings.push('该快照不完整（文件数或体积触顶），只还原文件、不删除新增文件')
  } else {
    if (manifest.skipped?.large > 0 || manifest.skipped?.error > 0) {
      warnings.push('该快照跳过了部分文件，这些路径不会被改动')
    }
    for (const p of current.entries.keys()) {
      if (wanted.has(p)) continue
      try {
        await unlink(resolve(cwd, p))
        deleted.push(p)
      } catch (error) {
        warnings.push(`删除 ${p} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await pruneEmptyDirs(cwd, cfg.ignoreDirs)
  }

  return { restored, deleted, skipped, warnings }
}

/** 删掉回滚后空掉的目录（只删空目录，且不越过工作区根）。 */
async function pruneEmptyDirs(cwd, ignoreDirs) {
  const ignore = new Set(ignoreDirs)
  /** 深度优先，返回该目录是否已空。 */
  async function visit(dir) {
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    let empty = true
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.isSymbolicLink() || ignore.has(dirent.name)) {
        empty = false
        continue
      }
      const child = join(dir, dirent.name)
      const childEmpty = await visit(child)
      if (childEmpty) {
        try {
          await rm(child, { recursive: false })
        } catch {
          empty = false
          continue
        }
      } else {
        empty = false
      }
    }
    return empty
  }
  await visit(cwd)
}

/** 一条表面节点上的用户消息记录（回滚点）。 */
function describeUserMessage(seq, event) {
  const data = event?.data
  const content = Array.isArray(data?.content) ? data.content : []
  const texts = []
  let images = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image') images += 1
  }
  const text = texts.join('\n')
  return {
    seq,
    time: typeof event?.time === 'number' ? event.time : 0,
    content,
    text: text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text,
    preview: text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
    chars: text.length,
    images,
  }
}

/** 事件是否是真人从界面发出的消息（web 端带 rpcId）。 */
export function isHumanPrompt(event) {
  if (event?.type !== 'user/message' || event.surfaceOp !== 'append') return false
  const source = event.data?.source
  return source !== null && typeof source === 'object' && source.kind === 'user' && typeof source.rpcId === 'string'
}

/**
 * 每个会话的表面投影：只保留「当前还在表面上」的节点，以及其中的真人消息。
 * 用 session/event 增量维护；插件加载时已经存在的会话用一次全量折叠补上。
 */
class SurfaceTracker {
  constructor() {
    this.sessions = new Map()
  }

  /** 取（必要时建立）某会话的投影状态。 */
  state(session) {
    let state = this.sessions.get(session.id)
    if (state === undefined) {
      state = { nodes: [], messages: new Map(), seeded: false }
      this.sessions.set(session.id, state)
      this.seed(session, state)
    }
    return state
  }

  /** 已经存在的会话：折叠一遍全量日志，把表面与真人消息补齐。 */
  seed(session, state) {
    state.seeded = true
    if (typeof session.snapshotEvents !== 'function') return
    let events
    try {
      events = session.snapshotEvents()
    } catch {
      return
    }
    for (const event of events) this.apply(state, event)
  }

  /** 应用一条事件到投影上（等价于官方的表面折叠，只保留我们需要的信息）。 */
  apply(state, event) {
    if (event === null || typeof event !== 'object') return
    const op = event.surfaceOp
    if (op === undefined) return
    if (op === 'append') {
      state.nodes.push(event.seq)
    } else if (op !== null && typeof op === 'object') {
      const startIdx = state.nodes.indexOf(op.startSeq)
      const endIdx = state.nodes.indexOf(op.endSeq)
      if (startIdx < 0 || endIdx < startIdx) {
        // 自己的投影和官方表面脱节了（正常路径不该发生）。宁可停用回滚，
        // 也不要按一个错的区段去替换 —— 那会截掉用户没想动的对话。
        state.desynced = true
        return
      }
      for (const seq of state.nodes.slice(startIdx, endIdx + 1)) state.messages.delete(seq)
      state.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    }
    if (isHumanPrompt(event)) state.messages.set(event.seq, describeUserMessage(event.seq, event))
  }

  /** 会话释放时丢掉投影。 */
  forget(sessionId) {
    this.sessions.delete(sessionId)
  }

  /** 当前表面上的真人消息，按时间顺序。 */
  points(session) {
    const state = this.state(session)
    if (state.desynced) return []
    return state.nodes
      .map((seq) => state.messages.get(seq))
      .filter((item) => item !== undefined)
  }

  /** 某条真人消息的完整记录（含原始 content），不在表面上时返回 undefined。 */
  message(session, seq) {
    const state = this.state(session)
    return state.desynced ? undefined : state.messages.get(seq)
  }

  /** 某条真人消息是否仍在表面上。 */
  has(session, seq) {
    const state = this.state(session)
    return state.desynced ? false : state.messages.has(seq)
  }

  /** 目标消息之后（含自身）的全部表面节点序号；投影不可信时返回 undefined。 */
  spanFrom(session, seq) {
    const state = this.state(session)
    if (state.desynced) return undefined
    const startIdx = state.nodes.indexOf(seq)
    if (startIdx < 0) return undefined
    return state.nodes.slice(startIdx)
  }

  /** 目标消息之后（含自身）还有多少个表面节点 —— 界面上用来说明「将撤回多少条」。 */
  tailCount(session, seq) {
    const state = this.state(session)
    if (state.desynced) return undefined
    const startIdx = state.nodes.indexOf(seq)
    return startIdx < 0 ? undefined : state.nodes.length - startIdx
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 读一个 JSON 请求体（带大小上限）。 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 业务失败：带一个稳定的 code，Client 半据此选文案。 */
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * 安装回滚能力：跟踪表面与真人消息、按用户消息边界拍工作区快照，并暴露三条路由。
 * @param ctx - 拥有这些注册的插件上下文。
 * @param rawConfig - patch 行里的 config（可选）。
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const store = new SnapshotStore(cfg.root, cfg)
  const tracker = new SurfaceTracker()
  /** 每会话的串行队列：快照与回滚都必须排队，避免两个动作交叉改写工作区。 */
  const queues = new Map()
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[rewind] ${message}`)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  /** 把任务排进某会话的串行队列；返回的 promise 由调用方决定怎么处理失败。 */
  function enqueue(sessionId, task) {
    const tail = queues.get(sessionId) ?? Promise.resolve()
    const run = tail.then(task, task)
    // 队列自身只保留「已完成」信号，失败不阻塞后续任务。
    queues.set(
      sessionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  /** 会话是否属于子代理（子代理不拍文件快照，也不在界面上回滚）。 */
  function eligible(session) {
    const { cwd, origin, delegationDepth } = session?.header ?? {}
    if (typeof cwd !== 'string' || cwd === '') return undefined
    if (origin === 'subagent' || (delegationDepth ?? 0) > 0) return undefined
    return cwd
  }

  /** 取实时会话：优先走 sessionController（它会把冷会话重新激活），退化到 ctx.sessions。 */
  async function liveSession(sessionId) {
    const controller = ctx.get?.('sessionController')
    if (controller !== undefined && typeof controller.resolveAgent === 'function') {
      try {
        const resolved = await controller.resolveAgent(sessionId)
        if (resolved !== null && typeof resolved === 'object' && 'agent' in resolved && resolved.agent) {
          return { agent: resolved.agent, session: resolved.agent.session }
        }
        if (resolved !== null && typeof resolved === 'object' && 'error' in resolved) {
          return { error: resolved.error }
        }
      } catch (error) {
        log('warn', `resolveAgent(${sessionId}) 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const sessions = ctx.get?.('sessions')
    const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    if (session !== undefined) return { session }
    return { error: { code: 'session/not-live', message: '会话尚未激活' } }
  }

  // ---- 快照：每条真人消息落地时拍一份 ----
  ctx.on('session/event', (session, event) => {
    if (session === undefined || event === undefined) return
    tracker.apply(tracker.state(session), event)
    if (!isHumanPrompt(event)) return
    const cwd = eligible(session)
    if (cwd === undefined) return
    // 遍历立刻开始，只把索引更新排进队列：排队发来的第二条消息如果等前一次遍历，
    // 取到的可能已经是代理改过文件之后的样子，快照就不再等于「发出这条消息那一刻」。
    void (async () => {
      const summary = await store.snapshot(session, event.seq, cwd)
      if (summary === undefined) return
      const described = describeUserMessage(event.seq, event)
      await enqueue(session.id, async () => {
        const index = await store.readIndex(session.id)
        index.cwd = cwd
        if (index.points.some((point) => point.seq === event.seq)) return
        // 取景期间这条消息可能已经被回滚掉：那时不能再写回索引，否则列表里留下幽灵回滚点。
        const last = index.lastRollback
        if (last !== undefined && event.seq > last.targetSeq && event.seq < last.atSeq) return
        index.points.push({
          seq: described.seq,
          // at = 快照拍下的时刻；time = 这条消息自己的时间。读回时靠 at 做形状校验。
          at: summary.at,
          time: described.time,
          preview: described.preview,
          chars: described.chars,
          images: described.images,
          snapshot: summary,
        })
        index.points.sort((a, b) => a.seq - b.seq)
        while (index.points.length > cfg.maxPoints) {
          const dropped = index.points.shift()
          if (dropped !== undefined) await store.dropSnapshot(session.id, dropped.snapshot?.id ?? `s${dropped.seq}`)
        }
        await store.writeIndex(session.id, index)
      })
    })().catch((error) => {
      log('warn', `快照失败（${session.id} seq=${event.seq}）：${error instanceof Error ? error.message : String(error)}`)
    })
  })

  ctx.on('session/disposed', (session) => {
    if (session === undefined) return
    tracker.forget(session.id)
    queues.delete(session.id)
  })

  // ---- 路由 ----
  const reject = (req, res) => {
    const connection = ctx.get?.('connection')
    if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** GET /rewind/points：列出可回滚的消息。 */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: POINTS_PATH,
        handler: async (req, res) => {
          if (reject(req, res)) return
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          const url = new URL(req.url ?? POINTS_PATH, 'http://127.0.0.1')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          if (sessionId === '') {
            sendJson(res, 400, fail('bad-request', '缺少 sessionId'))
            return
          }
          try {
            sendJson(res, 200, await collectPoints(sessionId))
          } catch (error) {
            sendJson(res, 500, fail('internal', error instanceof Error ? error.message : String(error)))
          }
        },
      }),
    `rewind: GET ${POINTS_PATH}`,
  )

  /** 汇总一个会话的回滚点（优先按实时表面过滤，退化到磁盘索引）。 */
  async function collectPoints(sessionId) {
    const index = await store.readIndex(sessionId)
    const live = await liveSession(sessionId)
    const session = 'session' in live ? live.session : undefined
    const agent = 'agent' in live ? live.agent : undefined
    const onSurface = session === undefined ? undefined : new Set(tracker.points(session).map((point) => point.seq))
    const points = []
    for (const point of index.points) {
      const snapshot = point.snapshot
      const ready = snapshot !== undefined && existsSync(store.manifestPath(sessionId, snapshot.id))
      points.push({
        seq: point.seq,
        at: point.at,
        time: point.time,
        preview: point.preview ?? '',
        chars: point.chars ?? 0,
        images: point.images ?? 0,
        active: onSurface === undefined ? undefined : onSurface.has(point.seq),
        tail: session === undefined ? undefined : tracker.tailCount(session, point.seq),
        snapshot: snapshot === undefined ? null : { ...snapshot, state: ready ? 'ready' : 'missing' },
      })
    }
    const cwd = session?.header?.cwd ?? index.cwd
    return {
      ok: true,
      sessionId,
      cwd,
      live: session !== undefined,
      busy: agent?.status === 'running',
      points,
      lastRollback: index.lastRollback ?? null,
      config: {
        restoreFiles: cfg.restoreFiles,
        keepMessage: cfg.keepMessage,
        maxPoints: cfg.maxPoints,
        ignoreDirs: cfg.ignoreDirs,
      },
    }
  }

  /** POST /rewind/apply：执行回滚。 */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: APPLY_PATH,
        handler: async (req, res) => {
          if (reject(req, res)) return
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            sendJson(res, 400, fail('bad-request', error instanceof Error ? error.message : String(error)))
            return
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const seq = Number(body.seq)
          if (sessionId === '' || !Number.isSafeInteger(seq) || seq < 0) {
            sendJson(res, 400, fail('bad-request', '缺少 sessionId 或 seq'))
            return
          }
          try {
            const result = await enqueue(sessionId, () =>
              applyRewind({
                sessionId,
                seq,
                restoreFiles: body.restoreFiles === undefined ? cfg.restoreFiles : body.restoreFiles !== false,
                keepMessage: body.keepMessage === undefined ? cfg.keepMessage : body.keepMessage === true,
              }),
            )
            sendJson(res, result.ok ? 200 : 409, result)
          } catch (error) {
            sendJson(res, 500, fail('internal', error instanceof Error ? error.message : String(error)))
          }
        },
      }),
    `rewind: POST ${APPLY_PATH}`,
  )

  /**
   * 执行一次回滚：先把上下文截断（表面区段替换 + 落盘），再按快照还原工作区。
   * @returns 成功时的回滚报告，或带 code 的业务失败。
   */
  async function applyRewind({ sessionId, seq, restoreFiles, keepMessage }) {
    const live = await liveSession(sessionId)
    if ('error' in live) return fail('session-not-live', '会话尚未激活，请先回到该对话再试')
    const { agent, session } = live
    if (agent !== undefined && agent.status === 'running') {
      return fail('agent-busy', '当前回合还在进行，请先停止后再回滚')
    }
    const span = tracker.spanFrom(session, seq)
    if (span === undefined || span.length === 0) {
      return fail('not-on-surface', '这条消息已不在当前上下文里（可能已被压缩或回滚过）')
    }
    // 表面 0 号节点是系统提示，只能被同样的 system/message 原地改写，这里直接拒绝。
    if (session.surface?.nodes?.[0] === seq) {
      return fail('protected-head', '不能回滚到系统提示所在位置')
    }
    const target = tracker.message(session, seq)
    if (target === undefined) return fail('not-found', '找不到这条消息的原文')
    const startSeq = span[0]
    const endSeq = span[span.length - 1]

    // 替换节点：内容为空时模型看不到任何东西（DeepSeek 适配器会跳过空 user 消息），
    // keepMessage 则携带原文，让上下文停在「这条消息刚发出」的那一刻。
    const message = {
      id: `rewind-${seq}-${Date.now()}`,
      role: 'user',
      content: keepMessage ? target.content : [],
      source: { kind: 'rewind', fromSeq: startSeq },
    }
    const event = session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: span,
    })

    // 截断必须落盘：回滚是用户对「确定性」的期待，不能只活在内存里。
    let flushed = false
    try {
      flushed = await ctx.get?.('sessions')?.flush?.(session)
    } catch (error) {
      log('warn', `flush(${sessionId}) 失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const report = {
      ok: true,
      value: {
        markerSeq: event.seq,
        hiddenSeqs: span,
        hiddenCount: span.length,
        keepMessage,
        preview: tracker.message(session, seq)?.preview ?? '',
        flushed: flushed === true,
        files: null,
        warnings: [],
      },
    }

    const cwd = eligible(session)
    const index = await store.readIndex(sessionId)
    const point = index.points.find((item) => item.seq === seq)
    const record = {
      at: Date.now(),
      targetSeq: seq,
      atSeq: event.seq,
      preview: point?.preview ?? '',
      keepMessage,
      hiddenCount: span.length,
      cwd,
      restored: 0,
      deleted: 0,
    }

    if (restoreFiles && cwd !== undefined && point?.snapshot !== undefined) {
      const manifest = await store.readManifest(sessionId, point.snapshot.id)
      if (manifest === undefined) {
        report.value.warnings.push('找不到这次消息的文件快照，只回滚了上下文')
      } else {
        // 还原前先给「现在」拍一份安全快照，文件回滚因此是可逆的。
        const safety = await store.snapshot(session, event.seq, cwd, `pre-rewind-${event.seq}`)
        const outcome = await restoreManifest(store, manifest, cfg)
        report.value.files = {
          restored: outcome.restored,
          deleted: outcome.deleted,
          skipped: outcome.skipped,
          snapshotAt: manifest.at,
          files: manifest.files,
        }
        report.value.warnings.push(...outcome.warnings)
        record.restored = outcome.restored.length
        record.deleted = outcome.deleted.length
        if (safety !== undefined) record.safety = safety.id
      }
    } else if (restoreFiles && point?.snapshot === undefined) {
      report.value.warnings.push('这条消息没有对应的文件快照，只回滚了上下文')
    }

    // 被回滚掉的那些消息的快照已经没有意义了，顺手清掉，避免列表里出现幽灵回滚点。
    for (const item of [...index.points]) {
      if (item.seq <= seq) continue
      index.points = index.points.filter((candidate) => candidate.seq !== item.seq)
      await store.dropSnapshot(sessionId, `s${item.seq}`)
    }
    index.lastRollback = record
    await store.writeIndex(sessionId, index)
    return report
  }

  /** POST /rewind/undo-files：只把文件恢复到上一次回滚之前（上下文不动）。 */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: UNDO_FILES_PATH,
        handler: async (req, res) => {
          if (reject(req, res)) return
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            sendJson(res, 400, fail('bad-request', error instanceof Error ? error.message : String(error)))
            return
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (sessionId === '') {
            sendJson(res, 400, fail('bad-request', '缺少 sessionId'))
            return
          }
          try {
            const result = await enqueue(sessionId, async () => {
              const index = await store.readIndex(sessionId)
              const last = index.lastRollback
              if (last === undefined) return fail('no-rollback', '这个会话还没有回滚过')
              if (typeof last.safety !== 'string') return fail('no-snapshot', '上一次回滚没有动过文件')
              const manifest = await store.readManifest(sessionId, last.safety)
              if (manifest === undefined) return fail('no-snapshot', '回滚前的安全快照已经不在了')
              const outcome = await restoreManifest(store, manifest, cfg)
              delete index.lastRollback
              await store.writeIndex(sessionId, index)
              return {
                ok: true,
                value: { restored: outcome.restored, deleted: outcome.deleted, skipped: outcome.skipped, warnings: outcome.warnings },
              }
            })
            sendJson(res, result.ok ? 200 : 409, result)
          } catch (error) {
            sendJson(res, 500, fail('internal', error instanceof Error ? error.message : String(error)))
          }
        },
      }),
    `rewind: POST ${UNDO_FILES_PATH}`,
  )

  log('info', `已启用，快照目录：${cfg.root}`)
}
