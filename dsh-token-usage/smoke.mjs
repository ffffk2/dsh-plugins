// 本机烟测：不启动 Harness，端到端跑一遍插件。
//   Host 半：假 ctx 真跑 apply → 灌 mock usage 流 → 走真路由取 stats → 校验累计/范围/落盘/清零
//   Client 半：假 React 真渲染页面，用上一步的真实 stats payload 断言关键节点
// 用法：node smoke.mjs [插件目录]，省略时用本脚本所在目录。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = process.argv[2] ?? dirname(fileURLToPath(import.meta.url))
let failed = 0
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`)
  if (!ok) failed += 1
}

/** 本地自然日 key，offset 为相对今天的天数。 */
function localDayKey(offset = 0) {
  const date = new Date()
  const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset)
  const month = String(shifted.getMonth() + 1).padStart(2, '0')
  const day = String(shifted.getDate()).padStart(2, '0')
  return `${shifted.getFullYear()}-${month}-${day}`
}

function emptyBucket(overrides = {}) {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, ...overrides }
}

// ---- 1. 清单与语言文件 ----
for (const file of ['package.json', 'locale/zh.json', 'locale/en.json']) {
  try {
    JSON.parse(readFileSync(join(dir, file), 'utf8'))
    check(true, `json 可解析：${file}`)
  } catch (error) {
    check(false, `json 解析失败：${file} → ${error.message}`)
  }
}

try {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  check(manifest.name === '@local/dsh-token-usage', `包名 = ${manifest.name}`)
  check(manifest.exports?.['./client'] === './client.js', 'package.json 导出 client 半')
  check(JSON.stringify(manifest.dsh?.client?.inject ?? []) === JSON.stringify(['@deepseek-ai/dsh-client-ui-settings']), 'client inject 指向官方 settings 模块')
  const zhMeta = JSON.parse(readFileSync(join(dir, 'locale/zh.json'), 'utf8')).meta
  check(zhMeta.title === manifest.meta.title && zhMeta.description === manifest.meta.description, 'zh.json meta 与 package.json meta 一致')
} catch (error) {
  check(false, `清单校验失败：${error.message}`)
}

// ---- 2. Host 半：端到端 ----
let statsAll = null
let stats7d = null
let stats30d = null
const e2eDir = mkdtempSync(join(tmpdir(), 'dsh-tu-e2e-'))
const persistPath = join(e2eDir, 'usage.json')

/** 一个只用到路由/事件/日志的最小 ctx。 */
function bootHost(path) {
  const routes = new Map()
  const listeners = new Map()
  const disposers = []
  const warnings = []
  const ctx = {
    logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
    get: () => undefined,
    on(name, listener) {
      listeners.set(name, listener)
      return () => {}
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
  }
  return { ctx, routes, listeners, disposers, warnings }
}

function request(app, path, method = 'GET') {
  const response = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body) { this.body = body } }
  app.routes.get(path.split('?')[0]).handler({ method, headers: {}, url: path }, response)
  return response
}

const readStats = (app, range) => JSON.parse(request(app, `/token-usage/stats?range=${range}`).body)

try {
  const mod = await import(pathToFileURL(join(dir, 'index.js')).href)
  check(typeof mod.apply === 'function' && mod.name === 'token-usage', 'index.js 导出 apply / name')
  check(Array.isArray(mod.inject) && mod.inject.includes('webServer'), 'index.js inject 含 webServer')

  const app = bootHost(persistPath)
  mod.apply(app.ctx, { persistPath, countInternalCalls: false, flushDelayMs: 0 })
  check(app.listeners.has('llm/stream'), 'Host 监听了 llm/stream')
  check(app.routes.has('/token-usage/stats') && app.routes.has('/token-usage/reset'), 'Host 注册了 stats / reset 两条路由')
  check(!app.routes.has('/token-usage/prices'), '费用功能已移除：不再注册单价路由')

  /** 灌一路 mock 模型流：listener(options, next)，next() 给出 usage chunk。 */
  async function feed(options, usage) {
    const source = (async function* () {
      yield { type: 'text-delta', index: 0, text: 'hi' }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
    const chunks = []
    for await (const chunk of app.listeners.get('llm/stream')(options, () => source)) chunks.push(chunk)
    return chunks
  }

  // 会话时长靠 Date.now 推进：每次调用间隔 45 秒，便于断言「最长会话」。
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => (clock += 45_000)

  const usageA = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, totalTokens: 420 }
  const chunks = await feed({ provider: 'p', model: 'm1', sessionId: 's1' }, usageA)
  check(chunks.length === 3, `透传下游 chunk 不变：3 → ${chunks.length}`)
  check(chunks[2]?.type === 'finish', '末帧仍是 finish（没有吞掉流）')
  await feed({ provider: 'p', model: 'm2', sessionId: 's1' }, { inputTokens: 50, outputTokens: 10, totalTokens: 60 })
  await feed({ provider: 'p', model: 'm1', sessionId: 's2' }, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  // 内部调用（purpose 非空）在 countInternalCalls:false 下不应计入
  await feed({ provider: 'p', model: 'm1', purpose: 'session-title' }, { inputTokens: 999, outputTokens: 999, totalTokens: 1998 })
  Date.now = realNow

  statsAll = readStats(app, 'all')
  stats7d = readStats(app, '7d')
  stats30d = readStats(app, '30d')

  check(statsAll.summary.calls === 3, `内部调用被排除：calls = ${statsAll.summary.calls}（期望 3）`)
  check(statsAll.summary.totalTokens === 495, `totalTokens = ${statsAll.summary.totalTokens}（420+60+15）`)
  check(statsAll.summary.inputTokens === 160 && statsAll.summary.outputTokens === 35, '输入/输出累计正确')
  check(statsAll.summary.cacheReadTokens === 300, '缓存命中累计正确')
  check(Math.abs(statsAll.summary.cacheHitRate - 300 / 460) < 1e-9, `缓存命中率 = ${statsAll.summary.cacheHitRate}（300 / 460）`)
  check(statsAll.summary.totalSessions === 2, `会话数 = ${statsAll.summary.totalSessions}（期望 2）`)
  check(statsAll.summary.longestSessionMs === 45_000, `最长会话 = ${statsAll.summary.longestSessionMs}ms（期望 45000）`)
  check(statsAll.summary.activeDays === 1, `活跃天数 = ${statsAll.summary.activeDays}`)
  check(statsAll.summary.peakDayTokens === 495, `峰值 Token = ${statsAll.summary.peakDayTokens}`)
  check(statsAll.summary.currentStreakDays === 1 && statsAll.summary.longestStreakDays === 1, '连续天数 = 1 / 1')
  check(statsAll.summary.favoriteModel?.model === 'm1', `最常用模型 = ${statsAll.summary.favoriteModel?.model}`)

  check(Array.isArray(statsAll.models) && statsAll.models.length === 2, `models 有 2 条：${statsAll.models?.length}`)
  check(statsAll.models[0].key === 'p/m1' && statsAll.models[0].totalTokens === 435, 'models 按 totalTokens 倒序')
  check(Math.abs(statsAll.models[0].share - 435 / 495) < 1e-9, `模型占比 = ${statsAll.models[0].share}`)
  check(statsAll.models[0].provider === 'p' && statsAll.models[0].model === 'm1', 'model 条目带 provider / model')
  check(statsAll.dailyModelUsage.length === 0, 'all 不返回每日曲线（省流量）')
  check(statsAll.heatmap.weeks.length === 52, `热力图 52 周：${statsAll.heatmap.weeks.length}`)
  const heatCells = statsAll.heatmap.weeks.flatMap((week) => week.days).filter(Boolean)
  check(heatCells.length > 300, `热力图格子数 = ${heatCells.length}`)
  const todayCell = heatCells.find((cell) => cell.date === localDayKey(0))
  check(todayCell?.totalTokens === 495 && todayCell?.calls === 3, `今天的格子 = ${todayCell?.totalTokens} tokens / ${todayCell?.calls} 次`)
  check(todayCell?.level >= 1 && todayCell?.level <= 4, `今天的格子有亮度等级：${todayCell?.level}`)

  check(stats7d.dailyModelUsage.length === 7, `7d 补齐 7 天：${stats7d.dailyModelUsage.length}`)
  check(stats30d.dailyModelUsage.length === 30, `30d 补齐 30 天：${stats30d.dailyModelUsage.length}`)
  const lastDay = stats7d.dailyModelUsage.at(-1)
  check(lastDay?.date === localDayKey(0), `7d 最后一天是今天：${lastDay?.date}`)
  check(lastDay?.models?.length === 2, `今天的每日明细有 2 个模型：${lastDay?.models?.length}`)
  check(stats7d.summary.totalTokens === 495, '7d 总量与 all 一致（数据都在今天）')

  check(request(app, '/token-usage/stats?range=bogus').statusCode === 200, '非法 range 回落到 all')
  check(JSON.parse(request(app, '/token-usage/stats?range=bogus').body).range === 'all', '非法 range 的 range 字段 = all')
  check(request(app, '/token-usage/reset', 'GET').statusCode === 405, 'GET /reset → 405')
  check(request(app, '/token-usage/stats', 'POST').statusCode === 405, 'POST /stats → 405')
  check(request(app, '/token-usage/stats').headers['content-type']?.includes('application/json'), 'stats content-type 正确')
  check(request(app, '/token-usage/stats').headers['cache-control'] === 'no-store', 'stats 不缓存')

  // 落盘：最后一个 effect 是 dispose 时的补写
  app.disposers[app.disposers.length - 1]()
  check(existsSync(persistPath), 'dispose 时把累计落盘')
  const onDisk = JSON.parse(readFileSync(persistPath, 'utf8'))
  check(onDisk.version === 2, `落盘 state 版本 = ${onDisk.version}`)
  check(onDisk.totals.calls === 3 && onDisk.totals.totalTokens === 495, '落盘总量与内存一致')
  check(onDisk.models['p/m1']?.totalTokens === 435, '落盘按 provider/model 分桶')
  const diskDay = onDisk.days[localDayKey(0)]
  check(diskDay?.models?.['p/m1']?.totalTokens === 435, '落盘按天再按模型分层')
  check(Object.keys(onDisk.sessions ?? {}).length === 2, `落盘会话数 = ${Object.keys(onDisk.sessions ?? {}).length}`)
  check(onDisk.longestSessionMs === 45_000, `落盘最长会话 = ${onDisk.longestSessionMs}`)
  check(onDisk.prices === undefined, '不再落盘单价配置')

  const resetResponse = request(app, '/token-usage/reset', 'POST')
  const afterReset = JSON.parse(resetResponse.body)
  check(resetResponse.statusCode === 200 && afterReset.summary.totalTokens === 0 && afterReset.summary.calls === 0, 'POST /reset 清零')
  check(afterReset.models.length === 0 && afterReset.dailyModelUsage.every((day) => day.models.length === 0), 'reset 后模型与每日明细清空')
  check(afterReset.summary.totalSessions === 0 && afterReset.summary.longestSessionMs === 0, 'reset 后会话与最长会话清空')
} catch (error) {
  check(false, `Host 端到端失败：${error.stack}`)
}

// ---- 3. 数据兜底：损坏留证 / 快照恢复 / 清零可悔 / v1 兼容 ----
const mod = await import(pathToFileURL(join(dir, 'index.js')).href)

/** 造一份 v1 文件（没有 days.models / sessions / prices 之外的 v2 字段）。 */
function seedV1(path, calls, tokens, overrides = {}) {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      since: Date.now() - 86_400_000,
      updatedAt: Date.now(),
      totals: emptyBucket({ calls, inputTokens: tokens, totalTokens: tokens }),
      models: { 'p/a': { provider: 'p', model: 'a', ...emptyBucket({ calls, inputTokens: tokens, totalTokens: tokens }) } },
      days: { [localDayKey(0)]: emptyBucket({ calls, inputTokens: tokens, totalTokens: tokens }) },
      prices: { 'p/a': { input: 2 } },
      pricesUpdatedAt: 0,
      ...overrides,
    }, null, 2),
  )
}

async function call(app, path, method, body) {
  const response = { statusCode: 0, headers: {}, setHeader() {}, end(payload) { this.body = payload } }
  const req = {
    method,
    headers: {},
    url: path,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  await app.routes.get(path.split('?')[0]).handler(req, response)
  return response.body ? JSON.parse(response.body) : null
}

function bootApp(persistPath, config = {}) {
  const app = bootHost(persistPath)
  mod.apply(app.ctx, { persistPath, flushDelayMs: 0, ...config })
  return app
}

try {
  // ① 清零前自动快照 → 手滑可回滚
  const resetDir = mkdtempSync(join(tmpdir(), 'dsh-tu-reset-'))
  const resetPath = join(resetDir, 'usage.json')
  seedV1(resetPath, 39, 1581960)
  check((await call(bootApp(resetPath), '/token-usage/stats', 'GET')).summary.calls === 39, '兜底① 读回 39 次调用')
  await call(bootApp(resetPath), '/token-usage/reset', 'POST', {})
  check((await call(bootApp(resetPath), '/token-usage/stats', 'GET')).summary.calls === 0, '兜底① 清零生效')
  const resetSnaps = readdirSync(resetDir).filter((name) => name.includes('.snapshot-'))
  check(resetSnaps.length >= 1, `兜底① 清零前留了快照：${resetSnaps.length} 份`)
  if (resetSnaps.length > 0) {
    const saved = JSON.parse(readFileSync(join(resetDir, resetSnaps[0]), 'utf8'))
    check(saved.totals.calls === 39, `兜底① 快照保留清零前的 39 次（实际 ${saved.totals.calls}）`)
  }
  rmSync(resetDir, { recursive: true, force: true })

  // ② 主文件损坏（空文件，掉电最典型的样子）→ 从快照恢复，而不是从零
  const corruptDir = mkdtempSync(join(tmpdir(), 'dsh-tu-corrupt-'))
  const corruptPath = join(corruptDir, 'usage.json')
  seedV1(corruptPath, 39, 1581960)
  writeFileSync(`${corruptPath}.snapshot-111`, readFileSync(corruptPath, 'utf8'))
  writeFileSync(corruptPath, '')
  const corruptApp = bootApp(corruptPath)
  const recoveredStats = await call(corruptApp, '/token-usage/stats', 'GET')
  check(recoveredStats.summary.calls === 39, `兜底② 损坏后从快照恢复 39 次（实际 ${recoveredStats.summary.calls}）`)
  check(typeof recoveredStats.restoredFrom === 'string' && recoveredStats.restoredFrom.includes('.snapshot-'), '兜底② 回报了恢复来源')
  check(typeof recoveredStats.corruptBackup === 'string', '兜底② 损坏文件被备份留证')
  check(readdirSync(corruptDir).some((name) => name.includes('.corrupt-')), '兜底② 目录里能看到损坏备份（数据没丢）')
  check(corruptApp.warnings.some((message) => message.includes('从快照恢复')), '兜底② 打了恢复日志')
  rmSync(corruptDir, { recursive: true, force: true })

  // ③ 主文件被误删 → 也能从快照救回
  const goneDir = mkdtempSync(join(tmpdir(), 'dsh-tu-gone-'))
  const gonePath = join(goneDir, 'usage.json')
  seedV1(gonePath, 12, 5000)
  writeFileSync(`${gonePath}.snapshot-222`, readFileSync(gonePath, 'utf8'))
  rmSync(gonePath, { force: true })
  check((await call(bootApp(gonePath), '/token-usage/stats', 'GET')).summary.calls === 12, '兜底③ 文件被误删时从快照救回')
  rmSync(goneDir, { recursive: true, force: true })

  // ④ 垃圾 JSON 不能被当成合法统计而悄悄清空
  for (const [label, content] of [['null', 'null'], ['数组', '[1,2,3]'], ['无关对象', '{"foo":"bar"}']]) {
    const junkDir = mkdtempSync(join(tmpdir(), 'dsh-tu-junk-'))
    const junkPath = join(junkDir, 'usage.json')
    writeFileSync(junkPath, content)
    const junkStats = await call(bootApp(junkPath), '/token-usage/stats', 'GET')
    check(junkStats.corruptBackup !== undefined, `兜底④ ${label} 被判为损坏并留证`)
    rmSync(junkDir, { recursive: true, force: true })
  }

  // ⑤ 快照数量封顶
  const pruneDir = mkdtempSync(join(tmpdir(), 'dsh-tu-prune-'))
  const prunePath = join(pruneDir, 'usage.json')
  for (let index = 0; index < 8; index += 1) {
    seedV1(prunePath, index + 1, (index + 1) * 100)
    await call(bootApp(prunePath), '/token-usage/reset', 'POST', {})
  }
  const snapCount = readdirSync(pruneDir).filter((name) => name.includes('.snapshot-')).length
  check(snapCount <= 5, `兜底⑤ 快照封顶 5 份：实际 ${snapCount}`)
  check(!readdirSync(pruneDir).some((name) => name.endsWith('.tmp')), '兜底⑥ 写盘不留 .tmp 残留')
  rmSync(pruneDir, { recursive: true, force: true })

  // ⑦ 旧代码自查
  const staleDir = mkdtempSync(join(tmpdir(), 'dsh-tu-stale-'))
  const staleCopy = join(staleDir, 'index.js')
  writeFileSync(staleCopy, readFileSync(join(dir, 'index.js'), 'utf8'))
  const stalePath = join(staleDir, 'usage.json')
  const staleMod = await import(pathToFileURL(staleCopy).href)
  const staleRoutes = new Map()
  staleMod.apply(
    {
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
      on: () => {},
      effect: (callback) => { const disposer = callback(); return () => disposer?.() },
      webServer: { register: (route) => { staleRoutes.set(route.path, route); return () => {} } },
    },
    { persistPath: stalePath, flushDelayMs: 0 },
  )
  const readStale = () => {
    const response = { statusCode: 0, headers: {}, setHeader() {}, end(payload) { this.body = payload } }
    staleRoutes.get('/token-usage/stats').handler({ method: 'GET', headers: {}, url: '/token-usage/stats' }, response)
    return JSON.parse(response.body)
  }
  check(readStale().staleSince == null, '兜底⑦ 刚加载的代码不报「过期」')
  const ahead = new Date(Date.now() + 60_000)
  utimesSync(staleCopy, ahead, ahead)
  check(typeof readStale().staleSince === 'number', '兜底⑦ 文件被改后报出 staleSince（页面据此提示重启）')
  rmSync(staleDir, { recursive: true, force: true })

  // ⑧ v1 兼容：没有 days.models 的历史，差额归到「未分模型」，总量不许丢
  const legacyDir = mkdtempSync(join(tmpdir(), 'dsh-tu-v1-'))
  const legacyPath = join(legacyDir, 'usage.json')
  seedV1(legacyPath, 7, 700, {
    days: {
      [localDayKey(0)]: emptyBucket({ calls: 4, totalTokens: 400, inputTokens: 400 }),
      [localDayKey(-1)]: emptyBucket({ calls: 3, totalTokens: 300, inputTokens: 300 }),
    },
  })
  const legacyAll = await call(bootApp(legacyPath), '/token-usage/stats', 'GET')
  check(legacyAll.summary.totalTokens === 700, `兜底⑧ v1 文件总量保留：${legacyAll.summary.totalTokens}`)
  check(legacyAll.models.every((row) => row.key !== '__other__'), '兜底⑧ all 视图用终身模型表，不造「未分模型」')
  const legacy7d = await call(bootApp(legacyPath), '/token-usage/stats?range=7d', 'GET')
  const legacyOther = legacy7d.models.find((row) => row.key === '__other__')
  check(legacyOther?.totalTokens === 700, `兜底⑧ 7d 的 700 全部归到未分模型：${legacyOther?.totalTokens}`)
  const legacyDailyOther = legacy7d.dailyModelUsage.reduce((sum, day) => sum + (day.models.find((entry) => entry.key === '__other__')?.totalTokens ?? 0), 0)
  check(legacyDailyOther === 700, `兜底⑧ 每日明细也补齐未分模型：${legacyDailyOther}`)
  rmSync(legacyDir, { recursive: true, force: true })
} catch (error) {
  check(false, `数据兜底验证失败：${error.stack}`)
}

// ---- 4. Client 半：真渲染 ----
/** 极简 React 替身：只实现本插件用到的那几个 hook，足够跑通渲染路径。 */
function createFakeReact() {
  const stores = new WeakMap()
  let active = null
  const enter = (type) => {
    let store = stores.get(type)
    if (store === undefined) {
      store = { cursor: 0, values: new Map() }
      stores.set(type, store)
    }
    const previous = active
    active = store
    store.cursor = 0
    return previous
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) {
      const store = active
      const index = store.cursor
      store.cursor += 1
      if (!store.values.has(index)) store.values.set(index, typeof initial === 'function' ? initial() : initial)
      return [
        store.values.get(index),
        (next) => {
          store.values.set(index, typeof next === 'function' ? next(store.values.get(index)) : next)
        },
      ]
    },
    useRef(initial) {
      const store = active
      const index = store.cursor
      store.cursor += 1
      if (!store.values.has(index)) store.values.set(index, { current: initial })
      return store.values.get(index)
    },
    useEffect(effect) {
      return effect()
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
  }
  /** 渲染一个函数组件（真实 React 的行为），hook store 按组件隔离。 */
  const renderComponent = (type, props) => {
    const previous = enter(type)
    try {
      return type(props)
    } finally {
      active = previous
    }
  }
  return { React, renderComponent }
}

/** 收集渲染树里的所有节点与文本，函数组件会被展开。 */
function collect(node, out = [], renderComponent = (type, props) => type(props)) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out, renderComponent)
    return out
  }
  out.push(node)
  if (typeof node.type === 'function') {
    collect(renderComponent(node.type, node.props), out, renderComponent)
    return out
  }
  for (const child of node.children ?? []) collect(child, out, renderComponent)
  return out
}

const classOf = (node) => (typeof node === 'object' && node !== null ? String(node.props?.className ?? '') : '')
const hasClass = (node, name) => classOf(node).split(/\s+/).includes(name)

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
}
globalThis.fetch = async (url) => {
  const target = String(url)
  const payload = target.includes('range=7d') ? stats7d : target.includes('range=30d') ? stats30d : statsAll
  return { ok: true, status: 200, json: async () => payload }
}

try {
  check(statsAll !== null && stats7d !== null, '拿到 Host 的真实 stats payload，用于渲染')
  await import(pathToFileURL(join(dir, 'client.js')).href)
  check(loaded !== null, 'client.js 调用了 window.__ModuleLoader__.load')
  check(loaded?.id === '@local/dsh-token-usage', `client.js 注册 id = ${loaded?.id}`)

  const { React, renderComponent } = createFakeReact()
  const mod2 = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`client.js 只应 require('react')，实际请求了 ${name}`)
  })
  check(typeof mod2.apply === 'function', 'client.js 工厂返回 apply')
  check(Array.isArray(mod2.inject) && mod2.inject.includes('slots') && mod2.inject.includes('locale'), `client.js inject = ${mod2.inject}`)

  const registered = []
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dicts) => {
        if (!dicts.zh?.nav || !dicts.en?.nav) throw new Error('语言表缺少 nav')
        for (const key of ['heatmapCell', 'heatmapWeeklyCell', 'heatmapCumulativeCell']) {
          if (!String(dicts.zh[key] ?? '').includes('{tokens}')) throw new Error(`zh.${key} 缺少 {tokens} 占位`)
          if (!String(dicts.en[key] ?? '').includes('{tokens}')) throw new Error(`en.${key} 缺少 {tokens} 占位`)
        }
        const zhKeys = Object.keys(dicts.zh).sort().join(',')
        const enKeys = Object.keys(dicts.en).sort().join(',')
        if (zhKeys !== enKeys) throw new Error('zh/en 字典键不一致')
        return () => {}
      },
    },
    slots: {
      inject: (key, callback) => {
        if (key !== 'settings.section') throw new Error(`slot key 异常：${key}`)
        registered.push(callback())
        return () => {}
      },
      register: (options, component) => {
        if (options.name !== 'settings.section' || options.id !== 'token-usage') throw new Error('slot 注册参数异常')
        registered.push(component)
        return () => {}
      },
    },
    effect: (callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  mod2.apply(ctx)
  const Section = registered.find((entry) => typeof entry === 'function')
  check(typeof Section === 'function', 'settings.section 注册了组件')

  // 多渲染几轮：第 1 轮 loading，fetch 落定后才能拿到数据。
  let tree = null
  for (let round = 0; round < 6; round += 1) {
    tree = renderComponent(Section, { close: () => {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const nodes = collect(tree, [], renderComponent)
  if (process.env.DSH_SMOKE_DEBUG) {
    console.log(`[debug] classNames: ${[...new Set(nodes.map(classOf).filter(Boolean))].sort().join(' ')}`)
    for (const node of nodes.filter((entry) => entry.type === 'div' && hasClass(entry, 'dshtu-strip-cell'))) {
      console.log(`[debug] strip cell: ${JSON.stringify(node.children?.map((child) => child?.children?.[0]))}`)
    }
  }

  const stripCells = nodes.filter((node) => hasClass(node, 'dshtu-strip-cell'))
  const stripValues = nodes.filter((node) => hasClass(node, 'dshtu-strip-value'))
  const heatCols = nodes.filter((node) => hasClass(node, 'dshtu-heatmap-col'))
  const heatCells = nodes.filter((node) => hasClass(node, 'dshtu-heatmap-cell'))
  const titled = heatCells.filter((node) => typeof node.props?.title === 'string')
  const tabs = nodes.filter((node) => hasClass(node, 'dshtu-tab'))
  const activeTabs = nodes.filter((node) => hasClass(node, 'dshtu-tab') && hasClass(node, 'is-on'))
  const lines = nodes.filter((node) => node.type === 'path' && classOf(node).includes('dshtu-line'))
  const axisLabels = nodes.filter((node) => hasClass(node, 'dshtu-axis-label'))
  const legendItems = nodes.filter((node) => hasClass(node, 'dshtu-legend-item'))
  const slices = nodes.filter((node) => classOf(node).includes('dshtu-ring-slice'))
  const modelRows = nodes.filter((node) => hasClass(node, 'dshtu-model-row'))
  const css = nodes.filter((node) => node.type === 'style').map((node) => String(node.children?.[0] ?? '')).join('')

  check(stripCells.length === 5, `指标条 5 格：${stripCells.length}`)
  check(stripValues.length === 5 && stripValues.every((node) => String(node.children?.[0] ?? '').length > 0), '指标条每格都有值')
  check(String(stripValues[0]?.children?.[0]) === '495', `累计 Token 显示 = ${String(stripValues[0]?.children?.[0])}`)
  check(heatCols.length === 52, `热力图 52 列：${heatCols.length}`)
  check(heatCells.length === 364, `热力图 364 格：${heatCells.length}`)
  check(titled.length >= 350, `热力图格子带 tooltip：${titled.length}`)
  check(titled.every((node) => typeof node.props.title === 'string' && node.props.title.length > 0), '每个 tooltip 都是非空字符串')
  check(
    heatCells.some((node) => node.props?.['data-level'] === '4' && typeof node.props.title === 'string'),
    '用量最高的格子（今天）有 tooltip 与最高亮度',
  )
  check(tabs.length === 5, `热力图 3 个切换 + 时间范围 2 个，共 5：${tabs.length}`)
  check(activeTabs.length === 2, `默认选中项 2 个（每日 + 近 7 日）：${activeTabs.length}`)
  check(lines.length === 2, `折线图 2 条模型曲线：${lines.length}`)
  check(axisLabels.length === 7, `7 日横轴 7 个刻度：${axisLabels.length}`)
  check(legendItems.length === 2, `图表图例 2 项：${legendItems.length}`)
  check(slices.length === stats7d.models.length, `环形图切片 = 模型数（${stats7d.models.length}）：${slices.length}`)
  check(modelRows.length === stats7d.models.length, `模型明细行 = 模型数：${modelRows.length}`)
  check(nodes.some((node) => node.type === 'button' && String(node.children?.[0]) === 'refresh'), '有刷新按钮')
  check(nodes.some((node) => node.type === 'button' && String(node.children?.[0]) === 'reset'), '有清零按钮')
  check(!nodes.some((node) => classOf(node).includes('dshtu-cost') || classOf(node).includes('dshtu-price')), '页面不再有费用/单价节点')
  check(!nodes.some((node) => hasClass(node, 'dshtu-banner')), '代码不过期时不显示「旧版代码」横幅')
  check(!titled.some((node) => String(node.props.title).includes('corruptBackup')), '数据正常时不显示损坏提示')

  // 宿主 token 是唯一合法的颜色来源
  check(css.length > 1500, `样式随组件渲染：${css.length} 字符`)
  check(!/dshtu-[\w-]*[^{]*\{[^}]*:\s*#/.test(css), '无硬编码十六进制颜色')
  check(!/dshtu-[\w-]*[^{]*\{[^}]*:\s*(?:rgb|hsl)a?\(/.test(css), '无硬编码 rgb()/hsl() 颜色')
  const vars = [...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1])
  const strayVars = [...new Set(vars.filter((name) => !/^--(?:dsw-alias|dsw-specific|ds-font)-/.test(name)))]
  check(strayVars.length === 0, `只引用宿主放行的 token 家族：${strayVars.join(',') || '无越界'}`)
  check(vars.length > 0, '确实用到了宿主 token')
  const classes = [...new Set([...css.matchAll(/(?<![\w-])\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]))]
  check(classes.length >= 25 && classes.every((name) => name.startsWith('dshtu-')), `类名全部带 dshtu- 前缀（${classes.length} 个）`)

  check(typeof statsAll.build === 'number' && statsAll.build > 0, `stats 回报代码版本：build ${statsAll.build}`)
  check(statsAll.staleSince === undefined || statsAll.staleSince === null, '刚写完的代码不该被判为过期')
} catch (error) {
  check(false, `client.js 渲染失败：${error.stack}`)
}

rmSync(e2eDir, { recursive: true, force: true })
console.log(failed === 0 ? '\n烟测通过' : `\n烟测失败：${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
