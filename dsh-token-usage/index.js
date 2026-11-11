/**
 * Token 统计 —— Host 半。
 *
 * 监听 `llm/stream`（每次流式模型调用都会经过的 waterfall），读取 adapter 上报的
 * `usage` chunk，把输入/输出/缓存/推理 token 记录到四个维度：
 *
 *   totals     全局合计
 *   models     按 provider/model
 *   days       按本地自然日，天里再按 provider/model 再分一层（趋势图与饼图要）
 *   sessions   按会话（首次/末次调用时间 + 调用次数），用来算「最长会话时长」
 *
 * 对外只暴露两条同源路由：
 *
 *   GET  /token-usage/stats?range=7d|30d|all   读取某个时间范围的统计快照
 *   POST /token-usage/reset                    清零累计（保留配置）
 *
 * 口径：同一路流里若出现多个 usage chunk，只有最后一个生效（与 agent-loop 的
 * BlockAssembler 一致，provider 常先报增量再报最终值）；inputTokens 不含缓存读写，
 * 缓存命中率 = cacheRead / (cacheRead + input)，与原设置页的算法一致。
 *
 * 为什么按天再存一层模型：ZCode 的 Usage 页有「每日多模型趋势」与「模型占比」两张图，
 * 只有全局按模型累计是画不出每天的曲线的。v1 的文件没有这一层，读取时按「未分模型」
 * 兜底（当天总量减去已知模型之和），保证升级前后的总量对得上，而不是静默丢历史。
 */
import { fileURLToPath } from 'node:url'
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, basename, join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'token-usage'
/** 需要 webServer 承载统计路由；connection 可选（存在时用于鉴权检查）。 */
export const inject = ['webServer']

const STATS_PATH = '/token-usage/stats'
const RESET_PATH = '/token-usage/reset'
/** 页面能请求的时间范围。all 只用于顶部指标条与热力图，不画每日曲线。 */
const RANGES = ['7d', '30d', 'all']
/** 热力图固定展示最近 52 个自然周（与 ZCode 一致）。 */
const HEATMAP_WEEKS = 52
const DAYS_PER_WEEK = 7
/** 本模块的磁盘路径与加载时刻，用于自查「跑的是不是旧代码」。 */
const MODULE_FILE = (() => {
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return undefined
  }
})()
const MODULE_LOADED_AT = Date.now()
/**
 * Host 半的代码版本号。
 *
 * 存在的理由：改了这个文件必须重启 DSH 才会生效（Node 会缓存已导入的 ES 模块，
 * 改文件不会重新导入），而「页面看起来正常、实际跑的是旧代码」极难排查——
 * 已经因此误判过两次（405 与「清零没反应」）。把它回报给页面，一旦运行中的代码
 * 比磁盘旧，就能当场看出来，而不是靠猜。
 * **每次改这个文件都顺手加一。**
 */
const HOST_BUILD = 6
const STATE_VERSION = 2
/** 按天表最多保留的天数，避免文件无限增长。 */
const MAX_DAYS = 400
/** 会话表最多保留的条数：只用于「最长会话时长」，不需要无限历史。 */
const MAX_SESSIONS = 500
/** 保留的历史快照份数；够回滚几次误操作，又不会让目录无限膨胀。 */
const MAX_SNAPSHOTS = 5
/** 快照文件名标记，与 .corrupt-（损坏备份）区分开。 */
const SNAPSHOT_MARK = '.snapshot-'
/** 每写这么多轮盘做一次快照，平衡「可回滚」与「磁盘噪音」。 */
const SNAPSHOT_EVERY_WRITES = 20
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
/** 没记到模型明细的历史总量，聚合成这一个伪模型，避免图表与总量对不上。 */
const OTHER_KEY = '__other__'
const COUNTERS = [
  'calls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
]

/** 一个空统计格（总量 / 某模型 / 某天共用）。 */
function newBucket() {
  const bucket = {}
  for (const key of COUNTERS) bucket[key] = 0
  return bucket
}

/** 只接受有限的正数；其它一律当 0。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 从任意来源重建一个统计格。 */
function sanitizeBucket(value) {
  const bucket = newBucket()
  if (value !== null && typeof value === 'object') {
    for (const key of COUNTERS) bucket[key] = num(value[key])
  }
  return bucket
}

/** 只取出计数器字段的浅拷贝。 */
function pickCounters(value) {
  const out = {}
  for (const key of COUNTERS) out[key] = num(value[key])
  return out
}

/** 把一份计数累加进统计格。 */
function addCounters(bucket, counters) {
  for (const key of COUNTERS) bucket[key] += num(counters[key])
}

/** 把一份 usage 累加进统计格。 */
function addUsage(bucket, usage) {
  const input = num(usage.inputTokens)
  const output = num(usage.outputTokens)
  bucket.calls += 1
  bucket.inputTokens += input
  bucket.outputTokens += output
  bucket.cacheReadTokens += num(usage.cacheReadTokens)
  bucket.cacheWriteTokens += num(usage.cacheWriteTokens)
  bucket.reasoningTokens += num(usage.reasoningTokens)
  bucket.totalTokens += num(usage.totalTokens) || input + output
}

/** 本地时区的 YYYY-MM-DD。 */
function dayKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** YYYY-MM-DD → 本地零点的 Date；不合法返回 undefined。 */
function parseDayKey(key) {
  if (typeof key !== 'string' || !DAY_PATTERN.test(key)) return undefined
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** 本地零点。 */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** 加减自然日（跨月/跨年由 Date 自己处理）。 */
function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** 闭区间里的每一天（升序，YYYY-MM-DD）。 */
function listDayKeys(start, end) {
  const keys = []
  let cursor = startOfDay(start)
  const last = startOfDay(end)
  // 上限只是防呆：范围再大也不该把进程跑死。
  while (cursor.getTime() <= last.getTime() && keys.length < MAX_DAYS + 366) {
    keys.push(dayKey(cursor))
    cursor = addDays(cursor, 1)
  }
  return keys
}

function newState() {
  const now = Date.now()
  return {
    version: STATE_VERSION,
    since: now,
    updatedAt: now,
    totals: newBucket(),
    models: {},
    days: {},
    sessions: {},
    /** 历史最长会话时长，单调递增；会话表被裁剪后也不丢。 */
    longestSessionMs: 0,
  }
}

/**
 * 原子 + 落盘写入：写 tmp → fsync → rename → fsync 目录。
 *
 * 只做 write+rename 还不够：rename 只保证「文件名替换是原子的」，不保证数据已经
 * 落到盘上。断电时可能留下一个长度为 0 或半截的目标文件——这正是「重启后统计没了」
 * 最典型的一种成因。先 fsync 文件内容、再 fsync 目录项，才能真正扛住掉电。
 * 平台不支持目录 fsync（Windows 会抛 EPERM/EINVAL）时忽略，不影响主流程。
 * @param path - 目标文件。
 * @param text - 完整内容。
 */
function writeFileAtomic(path, text) {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  try {
    const dirFd = openSync(dirname(path), 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch {
    /* 目录 fsync 在部分平台不可用，忽略 */
  }
}

/** 目录里按时间戳排序的某类备份文件（旧的在前）。 */
function listBackups(path, mark) {
  const dir = dirname(path)
  const base = `${basename(path)}${mark}`
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith(base))
    .sort()
    .map((name) => join(dir, name))
}

/** 只保留最近 max 份备份，多余的删掉，避免目录无限膨胀。 */
function pruneBackups(path, mark, max) {
  for (const old of listBackups(path, mark).slice(0, -max)) {
    try {
      unlinkSync(old)
    } catch {
      /* 删不掉就留着，不影响功能 */
    }
  }
}

/**
 * 读取历史累计；文件缺失时从零开始。
 *
 * 三重兜底，都是为了让「数据安静地消失」不再发生：
 *   1. 文件缺失（首次运行）→ 从零开始，正常。
 *   2. 文件存在但读不出来 / 解析不了 → 改名备份成 .corrupt-<时间戳>，再尝试从
 *      最近的快照恢复（而不是直接开新档）；恢复不了才从零。
 *   3. 解析成功但内容不像本插件写的（缺 totals/models/days）→ 视为损坏走同一路。
 * @param path - 落盘路径。
 * @returns {state, corrupt, restoredFrom} —— corrupt 非空表示遇到损坏文件。
 */
function loadState(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // 文件不存在 → 首次运行；但若存在快照，说明曾经有过数据（例如文件被误删），优先恢复。
    const snapshots = listBackups(path, SNAPSHOT_MARK)
    const recovered = readStateFromFile(snapshots[snapshots.length - 1])
    if (recovered !== undefined) return { state: recovered, corrupt: undefined, restoredFrom: snapshots[snapshots.length - 1] }
    return { state: newState(), corrupt: undefined, restoredFrom: undefined }
  }

  const parsed = parseStateJson(raw)
  if (parsed !== undefined) return { state: parsed, corrupt: undefined, restoredFrom: undefined }

  // 损坏：留下证据，再从最近的快照恢复，最后才从零。
  const backup = `${path}.corrupt-${Date.now()}`
  let backupNote
  try {
    renameSync(path, backup)
    backupNote = backup
  } catch {
    backupNote = `${path}（备份失败，原文件已保留）`
  }
  pruneBackups(path, '.corrupt-', MAX_SNAPSHOTS)
  const snapshots = listBackups(path, SNAPSHOT_MARK)
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const recovered = readStateFromFile(snapshots[index])
    if (recovered !== undefined) return { state: recovered, corrupt: backupNote, restoredFrom: snapshots[index] }
  }
  return { state: newState(), corrupt: backupNote, restoredFrom: undefined }
}

/** 读一个备份/快照文件还原 state；文件缺失、读不出或格式不符都返回 undefined。 */
function readStateFromFile(file) {
  if (typeof file !== 'string') return undefined
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  return parseStateJson(raw)
}

/** 一天里按模型的明细；v1 文件没有 models 字段，返回空对象交给「未分模型」兜底。 */
function sanitizeDayModels(value) {
  const out = {}
  if (value === null || typeof value !== 'object') return out
  for (const [key, bucket] of Object.entries(value)) {
    if (typeof key !== 'string' || key.trim() === '' || key === OTHER_KEY) continue
    if (bucket === null || typeof bucket !== 'object') continue
    out[key] = sanitizeBucket(bucket)
  }
  return out
}

/**
 * 把 JSON 文本解析成 state；内容不合理时返回 undefined（交给调用方当损坏处理）。
 * 判据是「必须含 totals 或 models 或 days 之一且为对象」，避免把 null/数组/别的
 * JSON 文件当成合法统计而悄悄清空。
 *
 * v1 文件没有 days[*].models / sessions：照常读入，只是那几天的「按模型」明细缺失，
 * 由 buildSnapshot 的「未分模型」补齐，不会因此判定为损坏。
 */
function parseStateJson(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const shapes = [parsed.totals, parsed.models, parsed.days]
  if (!shapes.some((value) => value !== null && typeof value === 'object')) return undefined
  try {
    const state = newState()
    if (Number.isFinite(parsed.since)) state.since = parsed.since
    if (Number.isFinite(parsed.updatedAt)) state.updatedAt = parsed.updatedAt
    state.totals = sanitizeBucket(parsed.totals)
    if (parsed.models !== null && typeof parsed.models === 'object') {
      for (const [key, value] of Object.entries(parsed.models)) {
        if (value === null || typeof value !== 'object') continue
        state.models[key] = {
          provider: typeof value.provider === 'string' ? value.provider : '',
          model: typeof value.model === 'string' ? value.model : '',
          ...sanitizeBucket(value),
        }
      }
    }
    if (parsed.days !== null && typeof parsed.days === 'object') {
      for (const [day, value] of Object.entries(parsed.days)) {
        if (!DAY_PATTERN.test(day)) continue
        const bucket = sanitizeBucket(value)
        bucket.models = sanitizeDayModels(value?.models)
        state.days[day] = bucket
      }
    }
    if (parsed.sessions !== null && typeof parsed.sessions === 'object') {
      for (const [id, value] of Object.entries(parsed.sessions)) {
        if (typeof id !== 'string' || id === '' || value === null || typeof value !== 'object') continue
        const firstAt = Number(value.firstAt)
        const lastAt = Number(value.lastAt)
        if (!Number.isFinite(firstAt) || !Number.isFinite(lastAt)) continue
        state.sessions[id] = {
          firstAt,
          lastAt: Math.max(firstAt, lastAt),
          calls: num(value.calls),
        }
      }
    }
    if (Number.isFinite(parsed.longestSessionMs)) state.longestSessionMs = num(parsed.longestSessionMs)
    return state
  } catch {
    return undefined
  }
}

/** 默认落盘位置：$DSH_HOME/token-usage/usage.json，跨机器/跨 profile 之外都稳定。 */
function defaultPersistPath() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  return join(home, 'token-usage', 'usage.json')
}

/** patch 里的 config 是裸 JSON（本插件不导出 Config schema），这里手动兜默认值。 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const path = typeof source.persistPath === 'string' && source.persistPath.trim() !== '' ? source.persistPath.trim() : defaultPersistPath()
  const flushDelayMs = Number.isFinite(source.flushDelayMs)
    ? Math.min(Math.max(Number(source.flushDelayMs), 0), 60_000)
    : 2_000
  return { persistPath: path, flushDelayMs, countInternalCalls: source.countInternalCalls !== false }
}

/** 透传下游 chunk，只在流结束时记录最后一个 usage。 */
async function* observeUsage(source, options, onUsage) {
  let usage
  try {
    for await (const chunk of source) {
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage) usage = chunk.usage
      yield chunk
    }
  } finally {
    if (usage) onUsage(options, usage)
  }
}

/**
 * 自查：磁盘上的 index.js 是否比正在运行的代码新。
 *
 * Node 会把已导入的模块缓存在内存里，改了文件不重启就不会生效。这里在每次提供
 * 统计时顺手比一下 mtime，把「跑的是旧代码」这件事变得可见——比继续靠人猜可靠。
 * @param file - 本模块的磁盘路径。
 * @param loadedAt - 模块被加载的时间戳。
 * @returns 磁盘文件比加载时间新则返回其 mtime，否则 undefined。
 */
function staleSince(file, loadedAt) {
  if (typeof file !== 'string' || !Number.isFinite(loadedAt)) return undefined
  try {
    const mtime = statSync(file).mtimeMs
    return mtime > loadedAt + 1000 ? mtime : undefined
  } catch {
    return undefined
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 从请求 URL 里取 range；非法值一律回落到 all。 */
function rangeFromUrl(url) {
  if (typeof url !== 'string') return 'all'
  const index = url.indexOf('?')
  if (index < 0) return 'all'
  try {
    const value = new URLSearchParams(url.slice(index + 1)).get('range')
    return RANGES.includes(value) ? value : 'all'
  } catch {
    return 'all'
  }
}

/**
 * 安装累计统计：监听模型流、落盘、并暴露统计路由。
 * @param ctx - 拥有这些注册的插件上下文。
 * @param rawConfig - patch 行里的 config（可选）。
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[token-usage] ${message}`)
    } catch {
      /* 日志失败不影响统计 */
    }
  }

  const loaded = loadState(cfg.persistPath)
  let state = loaded.state
  let lastCorruptBackup = loaded.corrupt
  let lastRestoredFrom = loaded.restoredFrom
  /** 上次清零时留下的快照，回报给页面用。 */
  let lastResetBackup
  let flushTimer
  /** 距上次快照的写入次数：不必每写一次都快照，够密就行。 */
  let writesSinceSnapshot = 0
  /** 上次快照对应的累计量，用来判断「数据涨了没有」。 */
  let lastSnapshotTokens = state.totals?.totalTokens ?? 0
  /** 最近一次写出的快照路径；清零时记下来，便于回报「可从哪恢复」。 */
  let lastSnapshotPath

  /**
   * 落一份历史快照。
   *
   * 快照是「除了损坏备份之外」的第二道防线：文件被误删、被别的程序覆盖、
   * 或者用户手滑点了清零，都还能从快照捞回来。只在累计真的增长时才快照，
   * 避免反复写同一份内容把有用的旧快照挤掉。
   */
  function snapshot(force) {
    const tokens = state.totals?.totalTokens ?? 0
    if (!force && tokens <= lastSnapshotTokens) return
    try {
      mkdirSync(dirname(cfg.persistPath), { recursive: true })
      const target = `${cfg.persistPath}${SNAPSHOT_MARK}${Date.now()}`
      writeFileAtomic(target, `${JSON.stringify(state, null, 2)}\n`)
      pruneBackups(cfg.persistPath, SNAPSHOT_MARK, MAX_SNAPSHOTS)
      lastSnapshotTokens = tokens
      lastSnapshotPath = target
    } catch (error) {
      log('warn', `写快照失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function flush() {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    try {
      mkdirSync(dirname(cfg.persistPath), { recursive: true })
      writeFileAtomic(cfg.persistPath, `${JSON.stringify(state, null, 2)}\n`)
      // 每若干次写入留一份快照，作为「主文件之外」的可回滚点。
      writesSinceSnapshot += 1
      if (writesSinceSnapshot >= SNAPSHOT_EVERY_WRITES) {
        writesSinceSnapshot = 0
        snapshot(false)
      }
    } catch (error) {
      log('warn', `写入 ${cfg.persistPath} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function scheduleFlush() {
    if (flushTimer !== undefined) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flush()
    }, cfg.flushDelayMs)
    // 未清理的 debounce 不该拖住进程退出。
    if (typeof flushTimer === 'object' && flushTimer !== null && typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  function trimDays() {
    const days = Object.keys(state.days)
    if (days.length <= MAX_DAYS) return
    days.sort()
    for (const day of days.slice(0, days.length - MAX_DAYS)) delete state.days[day]
  }

  /** 会话表只服务「最长会话时长」，超出上限就按最近活跃时间裁掉最旧的。 */
  function trimSessions() {
    const entries = Object.entries(state.sessions)
    if (entries.length <= MAX_SESSIONS) return
    entries.sort((left, right) => left[1].lastAt - right[1].lastAt)
    for (const [id] of entries.slice(0, entries.length - MAX_SESSIONS)) delete state.sessions[id]
  }

  function record(options, usage) {
    const provider = typeof options?.provider === 'string' ? options.provider : 'unknown'
    const model = typeof options?.model === 'string' ? options.model : 'unknown'
    const key = `${provider}/${model}`
    const day = dayKey(new Date())
    const now = Date.now()

    let entry = state.models[key]
    if (entry === undefined) {
      entry = { provider, model, ...newBucket() }
      state.models[key] = entry
    }
    addUsage(state.totals, usage)
    addUsage(entry, usage)

    if (state.days[day] === undefined) {
      const bucket = newBucket()
      bucket.models = {}
      state.days[day] = bucket
    }
    const dayBucket = state.days[day]
    addUsage(dayBucket, usage)
    if (dayBucket.models === undefined) dayBucket.models = {}
    if (dayBucket.models[key] === undefined) dayBucket.models[key] = newBucket()
    addUsage(dayBucket.models[key], usage)

    // 会话时长只统计真实会话调用；purpose 内部调用通常没有 sessionId，自然跳过。
    const sessionId = typeof options?.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : undefined
    if (sessionId !== undefined) {
      let session = state.sessions[sessionId]
      if (session === undefined) {
        session = { firstAt: now, lastAt: now, calls: 0 }
        state.sessions[sessionId] = session
      }
      session.lastAt = now
      session.calls += 1
      const duration = session.lastAt - session.firstAt
      if (duration > state.longestSessionMs) state.longestSessionMs = duration
      trimSessions()
    }

    state.updatedAt = now
    trimDays()
    scheduleFlush()
  }

  // ---- 统计口径 ----

  /** 某个范围的起止日；all 的起点取按天表里最早的一天。 */
  function rangeWindow(range) {
    const today = startOfDay(new Date())
    if (range === '7d') return { start: addDays(today, -(7 - 1)), end: today }
    if (range === '30d') return { start: addDays(today, -(30 - 1)), end: today }
    const days = Object.keys(state.days).sort()
    return { start: days.length > 0 ? (parseDayKey(days[0]) ?? today) : today, end: today }
  }

  /** 一天的「已分模型」之外的剩余量：v1 数据或未记录 session 的调用靠它兜住总量。 */
  function remainderOf(dayBucket, attributed) {
    const remainder = newBucket()
    for (const counter of COUNTERS) remainder[counter] = Math.max(0, num(dayBucket[counter]) - attributed[counter])
    return remainder
  }

  function modelMeta(key) {
    const known = state.models[key]
    if (known !== undefined) return { provider: known.provider, model: known.model }
    if (key === OTHER_KEY) return { provider: '', model: '' }
    const index = key.indexOf('/')
    if (index <= 0) return { provider: '', model: key }
    return { provider: key.slice(0, index), model: key.slice(index + 1) }
  }

  /** 把若干天聚合成一个范围：总量、按模型、每日按模型。 */
  function aggregate(range, dayKeys) {
    const models = new Map()
    const daily = []
    for (const key of dayKeys) {
      const bucket = state.days[key]
      const dayModels = []
      if (bucket !== undefined) {
        const attributed = newBucket()
        const perModel = bucket.models !== null && typeof bucket.models === 'object' ? bucket.models : {}
        for (const [modelKey, value] of Object.entries(perModel)) {
          const counters = pickCounters(value)
          addCounters(attributed, counters)
          let entry = models.get(modelKey)
          if (entry === undefined) {
            entry = { key: modelKey, ...modelMeta(modelKey), ...newBucket() }
            models.set(modelKey, entry)
          }
          addCounters(entry, counters)
          dayModels.push({ key: modelKey, totalTokens: counters.totalTokens })
        }
        const remainder = remainderOf(bucket, attributed)
        if (remainder.totalTokens > 0 || remainder.calls > 0) {
          let entry = models.get(OTHER_KEY)
          if (entry === undefined) {
            entry = { key: OTHER_KEY, provider: '', model: '', ...newBucket() }
            models.set(OTHER_KEY, entry)
          }
          addCounters(entry, remainder)
          dayModels.push({ key: OTHER_KEY, totalTokens: remainder.totalTokens })
        }
      }
      daily.push({ date: key, models: dayModels })
    }
    return { models, daily }
  }

  /** 从按天表算连续活跃天数；今天还没用时从昨天开始往前数，符合「连续天数」的直觉。 */
  function streaks(activeDays) {
    const active = new Set(activeDays)
    const today = startOfDay(new Date())
    let cursor = today
    if (!active.has(dayKey(cursor))) cursor = addDays(cursor, -1)
    let current = 0
    while (active.has(dayKey(cursor))) {
      current += 1
      cursor = addDays(cursor, -1)
    }

    let longest = 0
    let run = 0
    let previous
    for (const key of [...active].sort()) {
      const date = parseDayKey(key)
      if (date === undefined) continue
      if (previous !== undefined) {
        const expected = addDays(previous, 1)
        run = dayKey(expected) === key ? run + 1 : 1
      } else {
        run = 1
      }
      if (run > longest) longest = run
      previous = date
    }
    return { current, longest }
  }

  /** 最近 52 周的热力图（按自然周对齐，周日是第一行）。 */
  function buildHeatmap() {
    const today = startOfDay(new Date())
    const endWeekStart = addDays(today, -today.getDay())
    const start = addDays(endWeekStart, -(HEATMAP_WEEKS - 1) * DAYS_PER_WEEK)
    const weeks = []
    let max = 0
    for (let weekIndex = 0; weekIndex < HEATMAP_WEEKS; weekIndex += 1) {
      const days = []
      for (let dayOffset = 0; dayOffset < DAYS_PER_WEEK; dayOffset += 1) {
        const date = addDays(start, weekIndex * DAYS_PER_WEEK + dayOffset)
        if (date.getTime() > today.getTime()) {
          days.push(null)
          continue
        }
        const key = dayKey(date)
        const bucket = state.days[key]
        const totalTokens = bucket === undefined ? 0 : num(bucket.totalTokens)
        if (totalTokens > max) max = totalTokens
        days.push({ date: key, totalTokens, calls: bucket === undefined ? 0 : num(bucket.calls) })
      }
      weeks.push({ weekIndex, days })
    }
    for (const week of weeks) {
      for (const cell of week.days) {
        if (cell === null) continue
        cell.level = cell.totalTokens <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((cell.totalTokens / max) * 4)))
      }
    }
    return {
      startDate: dayKey(start),
      endDate: dayKey(today),
      maxTokens: max,
      weeks,
    }
  }

  /** 组装一个范围快照；页面按 range 各取一份。 */
  function buildSnapshot(range) {
    const window = rangeWindow(range)
    const dayKeys = listDayKeys(window.start, window.end)
    // all 不需要每日曲线（只画 7d / 30d），跳过逐天聚合，少做一次无用功。
    const aggregated = range === 'all' ? { models: new Map(), daily: [] } : aggregate(range, dayKeys)

    // all 的总量与按模型直接取全量记录：按天表只保留 MAX_DAYS 天，不能拿它冒充终身值。
    const totals = range === 'all' ? pickCounters(state.totals) : newBucket()
    if (range !== 'all') {
      for (const key of dayKeys) {
        const bucket = state.days[key]
        if (bucket !== undefined) addCounters(totals, bucket)
      }
    }

    let modelRows
    if (range === 'all') {
      modelRows = Object.entries(state.models).map(([key, value]) => ({
        key,
        provider: value.provider,
        model: value.model,
        ...pickCounters(value),
      }))
    } else {
      modelRows = [...aggregated.models.values()].map((value) => ({ key: value.key, provider: value.provider, model: value.model, ...pickCounters(value) }))
    }

    const activeDays = dayKeys.filter((key) => num(state.days[key]?.totalTokens) > 0)
    const peak = { day: null, tokens: 0 }
    for (const key of activeDays) {
      const tokens = num(state.days[key].totalTokens)
      if (tokens > peak.tokens) {
        peak.tokens = tokens
        peak.day = key
      }
    }
    // 连续天数按全部历史算：切到「近 7 日」也不该把已经攒了 30 天的连续记录改小。
    // 只认有 token 的日子，和热力图 / 活跃天数保持同一口径。
    const streak = streaks(Object.keys(state.days).filter((key) => num(state.days[key]?.totalTokens) > 0))
    const totalTokens = num(totals.totalTokens)
    const shareOf = (value) => (totalTokens > 0 ? value / totalTokens : 0)
    const models = modelRows
      .filter((row) => row.totalTokens > 0)
      .sort((left, right) => right.totalTokens - left.totalTokens)
      .map((row) => ({ ...row, share: shareOf(row.totalTokens) }))

    const favorite = models.length > 0 ? models[0] : null
    const cacheRead = num(totals.cacheReadTokens)
    const input = num(totals.inputTokens)
    const totalSessions =
      range === 'all'
        ? Object.keys(state.sessions).length
        : Object.values(state.sessions).filter((session) => session.lastAt >= window.start.getTime()).length

    return {
      range,
      generatedAt: Date.now(),
      since: state.since,
      updatedAt: state.updatedAt,
      file: cfg.persistPath,
      build: HOST_BUILD,
      stateVersion: state.version,
      corruptBackup: lastCorruptBackup,
      restoredFrom: lastRestoredFrom,
      resetBackup: lastResetBackup,
      staleSince: staleSince(MODULE_FILE, MODULE_LOADED_AT),
      summary: {
        ...totals,
        totalTokens,
        cacheHitRate: cacheRead + input > 0 ? cacheRead / (cacheRead + input) : 0,
        totalSessions,
        activeDays: activeDays.length,
        peakDayTokens: peak.tokens,
        peakDayDate: peak.day,
        currentStreakDays: streak.current,
        longestStreakDays: streak.longest,
        // 最长会话是单调递增的高水位，与范围无关：切范围不该让「最长会话」变小。
        longestSessionMs: state.longestSessionMs,
        favoriteModel: favorite === null ? null : { key: favorite.key, provider: favorite.provider, model: favorite.model, totalTokens: favorite.totalTokens, share: favorite.share },
      },
      // all 不画每日曲线：400 天 × 模型的数组没必要塞进每次请求。
      dailyModelUsage: range === 'all' ? [] : aggregated.daily,
      heatmap: buildHeatmap(),
      models,
    }
  }

  // ---- 累计：唯一的数据来源 ----
  ctx.on(
    'llm/stream',
    (options, next) => {
      const source = next()
      if (!cfg.countInternalCalls && options?.purpose !== undefined) return source
      return observeUsage(source, options, record)
    },
    { global: true },
  )

  // ---- 交给设置页读取 ----
  const reject = (req, res) => {
    const connection = ctx.get('connection')
    if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATS_PATH,
        handler: (req, res) => {
          if (reject(req, res)) return
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          sendJson(res, 200, buildSnapshot(rangeFromUrl(req.url)))
        },
      }),
    `token-usage: GET ${STATS_PATH}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RESET_PATH,
        handler: (req, res) => {
          if (reject(req, res)) return
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          // 清零前先强制快照：这个动作不可逆，留一份可回滚的副本，手滑也能救。
          snapshot(true)
          const snapshotPath = lastSnapshotPath
          state = newState()
          lastResetBackup = snapshotPath
          lastSnapshotTokens = 0
          flush()
          sendJson(res, 200, buildSnapshot(rangeFromUrl(req.url)))
        },
      }),
    `token-usage: POST ${RESET_PATH}`,
  )

  // 卸载时把未落盘的累计写出去。
  ctx.effect(
    () => () => {
      flush()
    },
    'token-usage: flush on dispose',
  )

  // 启动自检：损坏过、从快照恢复过、或两个 usage.json 并存，都要留痕。
  if (lastCorruptBackup !== undefined) {
    log('warn', `累计文件损坏，已备份到 ${lastCorruptBackup}。`)
  }
  if (lastRestoredFrom !== undefined) {
    log('warn', `已从快照恢复累计：${lastRestoredFrom}`)
  }
  const defaultPath = defaultPersistPath()
  if (cfg.persistPath !== defaultPath) {
    try {
      statSync(defaultPath)
      log('warn', `检测到两份累计文件：当前用 ${cfg.persistPath}，另有默认路径 ${defaultPath}。后者不参与统计，容易被误认为数据丢失。`)
    } catch {
      /* 只有默认路径不存在才是常态，无需提示 */
    }
  }

  log(
    'info',
    `已启用，累计文件：${cfg.persistPath}（build ${HOST_BUILD}，${Object.keys(state.models).length} 个模型 / ${Object.keys(state.days).length} 天）`,
  )
  // 启动瞬间就落后，说明用户改了文件但没重启——提示一次，省得后面反复排查。
  if (staleSince(MODULE_FILE, MODULE_LOADED_AT) !== undefined) {
    log('warn', '检测到磁盘上的插件代码比正在运行的更新，当前仍是旧代码。改 Host 半后需要重启 DSH 才会生效。')
  }
}
