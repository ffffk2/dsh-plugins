/**
 * Token 统计 —— Host 半。
 *
 * 监听 `llm/stream`（每次流式模型调用都会经过的 waterfall），读取 adapter 上报的
 * `usage` chunk，把输入/输出/缓存/推理 token 累计到三个维度：全局、按模型、按天，
 * 并落盘成一份 JSON。Client 半的设置页通过下面两条同源路由读取与清零：
 *
 *   GET  /token-usage/stats   读取累计统计
 *   POST /token-usage/reset   清零累计统计
 *
 * 口径说明：同一路流里若出现多个 usage chunk，只有最后一个生效（与
 * agent-loop 的 BlockAssembler 一致，provider 常常先报增量再报最终值）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'token-usage'
/** 需要 webServer 承载统计路由；connection 可选（存在时用于鉴权检查）。 */
export const inject = ['webServer']

const STATS_PATH = '/token-usage/stats'
const RESET_PATH = '/token-usage/reset'
const STATE_VERSION = 1
/** 按天表最多保留的天数，避免文件无限增长。 */
const MAX_DAYS = 400
/** 设置页默认展示的天数。 */
const DAYS_IN_PAGE = 90
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
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
  return { version: STATE_VERSION, since: now, updatedAt: now, totals: newBucket(), models: {}, days: {} }
}

/** 读取历史累计；文件缺失或损坏时从零开始，绝不拖垮 Host 启动。 */
function loadState(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return newState()
  }
  try {
    const parsed = JSON.parse(raw)
    const state = newState()
    if (parsed === null || typeof parsed !== 'object') return state
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
    return state
  } catch {
    return newState()
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

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
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

  let state = loadState(cfg.persistPath)
  let flushTimer

  function flush() {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    try {
      mkdirSync(dirname(cfg.persistPath), { recursive: true })
      const tmp = `${cfg.persistPath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
      renameSync(tmp, cfg.persistPath)
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
    const models = Object.entries(state.models)
      .map(([key, value]) => ({ key, provider: value.provider, model: value.model, ...pickCounters(value) }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
    const days = Object.entries(state.days)
      .map(([day, value]) => ({ day, ...pickCounters(value) }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
      .slice(0, DAYS_IN_PAGE)
    return {
      version: state.version,
      file: cfg.persistPath,
      since: state.since,
      updatedAt: state.updatedAt,
      totals: pickCounters(state.totals),
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
          state = newState()
          flush()
          sendJson(res, 200, serialize())
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

  log('info', `已启用，累计文件：${cfg.persistPath}`)
}
