/**
 * Token 统计 —— Host 半。
 *
 * 监听 `llm/stream`（每次流式模型调用都会经过的 waterfall），读取 adapter 上报的
 * `usage` chunk，把输入/输出/缓存/推理 token 累计到三个维度：全局、按模型、按天，
 * 并落盘成一份 JSON。Client 半的设置页通过下面几条同源路由读写：
 *
 *   GET  /token-usage/stats    读取累计统计（含按当前单价算出的费用）
 *   POST /token-usage/reset    清零累计统计（单价保留）
 *   GET  /token-usage/prices   读取单价表
 *   POST /token-usage/prices   覆盖单价表
 *
 * 口径说明：同一路流里若出现多个 usage chunk，只有最后一个生效（与
 * agent-loop 的 BlockAssembler 一致，provider 常常先报增量再报最终值）。
 *
 * 计费口径见 computeCost：四个计费项各算各的、互不重叠——inputTokens 不含缓存读写
 * （官方 chat UI 同样把 prompt 总量 - outputTokens - cacheRead 当作未命中缓存的输入，
 * 官方 token-meter 的字段名就叫 uncachedInputTokens），reasoning 已含在 output 里不再计。
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
const PRICES_PATH = '/token-usage/prices'
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
const HOST_BUILD = 4
const STATE_VERSION = 1
/** 按天表最多保留的天数，避免文件无限增长。 */
const MAX_DAYS = 400
/** 设置页默认展示的天数。 */
const DAYS_IN_PAGE = 90
/** 单价表最多保留的条目数，防止被写入超大 JSON。 */
const MAX_PRICES = 200
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
/** 保留的历史快照份数；够回滚几次误操作，又不会让目录无限膨胀。 */
const MAX_SNAPSHOTS = 5
/** 快照文件名标记，与 .corrupt-（损坏备份）区分开。 */
const SNAPSHOT_MARK = '.snapshot-'
/** 每写这么多轮盘做一次快照，平衡「可回滚」与「磁盘噪音」。 */
const SNAPSHOT_EVERY_WRITES = 20
const COUNTERS = [
  'calls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
]
/** 计费项：单价字段名 → 对应的计数器字段。 */
const PRICE_FIELDS = [
  ['input', 'inputTokens'],
  ['output', 'outputTokens'],
  ['cacheRead', 'cacheReadTokens'],
  ['cacheWrite', 'cacheWriteTokens'],
]
/** 单价单位：人民币元 / 百万 token。 */
const PER_TOKENS = 1_000_000
/** 单价上限，纯属防呆（再贵的模型也不会到 100 万/百万 token）。 */
const MAX_PRICE = 1_000_000
/** 费用保留 6 位小数，够精确又不至于输出天文数字。 */
const COST_SCALE = 1_000_000

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

/** 只接受非负有限数（单价允许填 0，表示免费）；其它一律 undefined。 */
function priceValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.min(value, MAX_PRICE)
}

/** 清洗一条单价：四个计费项都缺就返回 undefined（等于删除该模型的价格）。 */
function sanitizePrice(value) {
  if (value === null || typeof value !== 'object') return undefined
  const price = {}
  for (const [field] of PRICE_FIELDS) {
    const parsed = priceValue(value[field])
    if (parsed !== undefined) price[field] = parsed
  }
  return Object.keys(price).length === 0 ? undefined : price
}

/** 清洗整张单价表：只保留合法非空条目，条数封顶。 */
function sanitizePrices(value) {
  const out = {}
  if (value === null || typeof value !== 'object') return out
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || key.trim() === '' || key.length > 200) continue
    const price = sanitizePrice(raw)
    if (price !== undefined) out[key.trim()] = price
    if (Object.keys(out).length >= MAX_PRICES) break
  }
  return out
}

/** 费用四舍五入到 6 位小数，避免浮点尾差在页面上乱跳。 */
function roundCost(value) {
  return Math.round(value * COST_SCALE) / COST_SCALE
}

/**
 * 按单价算一格统计的费用。
 *
 * 四个计费项各算各的，互不重叠：本插件记录的 inputTokens **不含**缓存读写
 * （官方 chat UI 也是用 totalTokens - outputTokens 还原 prompt 总量，再把 cacheRead
 * 减出去得到未命中缓存的输入；实测数据里 cacheRead 远大于 inputTokens，若含则不可能）。
 * reasoningTokens 已含在 outputTokens 里，不另计。
 * 只填了部分单价时，缺的那项按 0 计（默认不额外收钱），并标记 partial 供页面提示。
 * @param bucket - 含 COUNTERS 的统计格。
 * @param price - 单价（人民币元 / 百万 token），未知时传 undefined。
 * @returns 费用明细；没有该模型单价时 known 为 false、金额全 0。
 */
function computeCost(bucket, price) {
  const usage = {
    input: num(bucket?.inputTokens),
    output: num(bucket?.outputTokens),
    cacheRead: num(bucket?.cacheReadTokens),
    cacheWrite: num(bucket?.cacheWriteTokens),
  }
  const known = price !== undefined && price !== null
  const items = {}
  let total = 0
  for (const [field] of PRICE_FIELDS) {
    const rate = known ? (priceValue(price[field]) ?? 0) : 0
    const cost = (usage[field] / PER_TOKENS) * rate
    items[field] = { tokens: usage[field], rate, cost: roundCost(cost) }
    total += cost
  }
  return {
    known,
    partial: known && PRICE_FIELDS.some(([field]) => priceValue(price[field]) === undefined),
    currency: 'CNY',
    unit: PER_TOKENS,
    currencyLabel: '¥',
    items,
    ...items,
    total: roundCost(total),
  }
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

function newState() {
  const now = Date.now()
  return {
    version: STATE_VERSION,
    since: now,
    updatedAt: now,
    totals: newBucket(),
    models: {},
    days: {},
    // 单价与累计放在同一个文件：设置页读写它、界面依赖它，本就是一份数据。
    prices: {},
    pricesUpdatedAt: 0,
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

/**
 * 把 JSON 文本解析成 state；内容不合理时返回 undefined（交给调用方当损坏处理）。
 * 判据是「必须含 totals 或 models 或 days 之一且为对象」，避免把 null/数组/别的
 * JSON 文件当成合法统计而悄悄清空。
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
        state.days[day] = sanitizeBucket(value)
      }
    }
    state.prices = sanitizePrices(parsed.prices)
    if (Number.isFinite(parsed.pricesUpdatedAt)) state.pricesUpdatedAt = parsed.pricesUpdatedAt
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

/** 读请求体，超过 256KB 直接判失败，避免被超大 body 拖住。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
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

  function record(options, usage) {
    const provider = typeof options?.provider === 'string' ? options.provider : 'unknown'
    const model = typeof options?.model === 'string' ? options.model : 'unknown'
    const key = `${provider}/${model}`
    const day = dayKey(new Date())
    let entry = state.models[key]
    if (entry === undefined) {
      entry = { provider, model, ...newBucket() }
      state.models[key] = entry
    }
    addUsage(state.totals, usage)
    addUsage(entry, usage)
    if (state.days[day] === undefined) state.days[day] = newBucket()
    addUsage(state.days[day], usage)
    state.updatedAt = Date.now()
    trimDays()
    scheduleFlush()
  }

  function serialize() {
    const prices = state.prices
    const models = Object.entries(state.models)
      .map(([key, value]) => {
        const counters = pickCounters(value)
        return {
          key,
          provider: value.provider,
          model: value.model,
          ...counters,
          cost: computeCost(counters, prices[key]),
        }
      })
      .sort((a, b) => b.totalTokens - a.totalTokens)
    const days = Object.entries(state.days)
      .map(([day, value]) => ({ day, ...pickCounters(value) }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
      .slice(0, DAYS_IN_PAGE)
    const totals = pickCounters(state.totals)
    return {
      version: state.version,
      file: cfg.persistPath,
      since: state.since,
      updatedAt: state.updatedAt,
      prices,
      pricesUpdatedAt: state.pricesUpdatedAt,
      currency: 'CNY',
      priceUnit: PER_TOKENS,
      currencyLabel: '¥',
      totals,
      // 总费用 = 有单价模型各自费用之和，未知单价的模型不计入（页面上单独提示）。
      totalCost: roundCost(models.reduce((sum, row) => sum + (row.cost?.total ?? 0), 0)),
      pricedModels: models.filter((row) => row.cost?.known).length,
      // 排障信息：损坏过 / 从快照恢复过 / 刚清零过，页面据此提示可从哪救回。
      corruptBackup: lastCorruptBackup,
      restoredFrom: lastRestoredFrom,
      resetBackup: lastResetBackup,
      // 代码版本与「磁盘比内存新」自查：跑旧代码时页面会明确提示要重启。
      build: HOST_BUILD,
      staleSince: staleSince(MODULE_FILE, MODULE_LOADED_AT),
      models,
      days,
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
          sendJson(res, 200, serialize())
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
          // 只清累计，单价是用户的配置不是统计数据，保留。
          const prices = state.prices
          const pricesUpdatedAt = state.pricesUpdatedAt
          const snapshotPath = lastSnapshotPath
          state = newState()
          state.prices = prices
          state.pricesUpdatedAt = pricesUpdatedAt
          lastResetBackup = snapshotPath
          flush()
          sendJson(res, 200, serialize())
        },
      }),
    `token-usage: POST ${RESET_PATH}`,
  )

  // ---- 单价：设置页里编辑，与累计同文件持久化 ----
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PRICES_PATH,
        handler: async (req, res) => {
          if (reject(req, res)) return
          if (req.method === 'GET') {
            sendJson(res, 200, serialize())
            return
          }
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, POST')
            res.end()
            return
          }
          const body = await readJsonBody(req)
          if (body === undefined || body === null || typeof body !== 'object') {
            sendJson(res, 400, { error: 'invalid-json' })
            return
          }
          const source = body.prices !== null && typeof body.prices === 'object' ? body.prices : body
          state.prices = sanitizePrices(source)
          state.pricesUpdatedAt = Date.now()
          flush()
          sendJson(res, 200, serialize())
        },
      }),
    `token-usage: GET/POST ${PRICES_PATH}`,
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
    `已启用，累计文件：${cfg.persistPath}（build ${HOST_BUILD}，单价 ¥/百万 token，${Object.keys(state.prices).length} 个模型已定价）`,
  )
  // 启动瞬间就落后，说明用户改了文件但没重启——提示一次，省得后面反复排查。
  if (staleSince(MODULE_FILE, MODULE_LOADED_AT) !== undefined) {
    log('warn', '检测到磁盘上的插件代码比正在运行的更新，当前仍是旧代码。改 Host 半后需要重启 DSH 才会生效。')
  }
}
