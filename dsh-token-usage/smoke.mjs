// 本机烟测：不启动 Harness，端到端跑一遍插件。
//   Host 半：假 ctx 真跑 apply → 灌 mock usage 流 → 走真路由取 stats → 校验累计/落盘/清零
//   Client 半：假 React 真渲染页面，用上一步的真实 stats payload 断言关键节点
// 用法：node smoke.mjs [插件目录]，省略时用本脚本所在目录。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = process.argv[2] ?? dirname(fileURLToPath(import.meta.url))
const persistPath = join(tmpdir(), `dsh-token-usage-smoke-${process.pid}.json`)
let failed = 0
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`)
  if (!ok) failed += 1
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

// ---- 2. Host 半：端到端 ----
let statsPayload = null
try {
  const mod = await import(pathToFileURL(join(dir, 'index.js')).href)
  check(typeof mod.apply === 'function' && mod.name === 'token-usage', 'index.js 导出 apply / name')
  check(Array.isArray(mod.inject) && mod.inject.includes('webServer'), 'index.js inject 含 webServer')

  if (existsSync(persistPath)) rmSync(persistPath)
  const listeners = new Map()
  const routes = new Map()
  const disposers = []
  const ctx = {
    logger: {},
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
  mod.apply(ctx, { persistPath, countInternalCalls: false, flushDelayMs: 0 })
  check(listeners.has('llm/stream'), 'Host 监听了 llm/stream')
  check(routes.has('/token-usage/stats') && routes.has('/token-usage/reset'), 'Host 注册了两条路由')
  check(routes.has('/token-usage/prices'), 'Host 注册了单价路由')

  /** 灌一路 mock 模型流：listener(options, next)，next() 给出 usage chunk。 */
  async function feed(options, usage) {
    const source = (async function* () {
      yield { type: 'text-delta', index: 0, text: 'hi' }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
    const chunks = []
    for await (const chunk of listeners.get('llm/stream')(options, () => source)) chunks.push(chunk)
    return chunks
  }

  const usageA = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, totalTokens: 420 }
  const chunks = await feed({ provider: 'opai-ds', model: 'deepseek/deepseek-flash' }, usageA)
  check(chunks.length === 3, `透传下游 chunk 不变：3 → ${chunks.length}`)
  check(chunks[2]?.type === 'finish', '末帧仍是 finish（没有吞掉流）')

  // 内部调用（purpose 非空）在 countInternalCalls:false 下不应计入
  await feed({ provider: 'opai-ds', model: 'deepseek/deepseek-flash', purpose: 'session-title' }, { inputTokens: 999, outputTokens: 999, totalTokens: 1998 })
  await feed({ provider: 'glm', model: 'glm-5.3', sessionId: undefined }, { inputTokens: 50, outputTokens: 10, cacheWriteTokens: 7, totalTokens: 60 })

  const request = (path, method) => {
    const response = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) {
        this.headers[key] = value
      },
      end(body) {
        this.body = body
      },
    }
    routes.get(path).handler({ method, headers: {}, url: path }, response)
    return response
  }

  /** 带 body 的请求：路由 handler 是 async，要 await 到 end 才拿到响应。 */
  const requestWithBody = async (path, method, body) => {
    const response = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) {
        this.headers[key] = value
      },
      end(payload) {
        this.body = payload
      },
    }
    const req = {
      method,
      headers: {},
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    await routes.get(path).handler(req, response)
    return response
  }

  const stats = request('/token-usage/stats', 'GET')
  statsPayload = JSON.parse(stats.body)
  check(stats.statusCode === 200, `GET /stats → ${stats.statusCode}`)
  check(stats.headers['content-type']?.includes('application/json'), 'GET /stats content-type 正确')
  check(stats.headers['cache-control'] === 'no-store', 'GET /stats 不缓存')
  check(statsPayload.totals.calls === 2, `内部调用被排除：calls = ${statsPayload.totals.calls}（期望 2）`)
  check(statsPayload.totals.totalTokens === 480, `totalTokens = ${statsPayload.totals.totalTokens}（420+60）`)
  check(statsPayload.totals.inputTokens === 150 && statsPayload.totals.outputTokens === 30, '输入/输出累计正确')
  check(statsPayload.totals.cacheReadTokens === 300 && statsPayload.totals.cacheWriteTokens === 7, '缓存读写累计正确')
  check(Array.isArray(statsPayload.models) && statsPayload.models.length === 2, `models 是数组且有 2 条：${statsPayload.models?.length}`)
  check(statsPayload.models[0].totalTokens === 420 && statsPayload.models[0].model === 'deepseek/deepseek-flash', 'models 按 totalTokens 倒序')
  check(Array.isArray(statsPayload.days) && statsPayload.days.length === 1, `days 是数组且有 1 条：${statsPayload.days?.length}`)
  check(statsPayload.models[0].provider === 'opai-ds', 'model 条目带 provider 字段')
  check(typeof statsPayload.file === 'string' && statsPayload.file === persistPath, 'payload 回传落盘路径')

  check(request('/token-usage/reset', 'GET').statusCode === 405, 'GET /reset → 405')
  check(request('/token-usage/stats', 'POST').statusCode === 405, 'POST /stats → 405')

  // ---- 3. 单价与费用 ----
  check(statsPayload.prices !== null && typeof statsPayload.prices === 'object', 'stats 回传 prices')

  // 初始没有单价：费用为 0 且标记为未知，绝不臆造金额
  check(statsPayload.models[0].cost.known === false, '未定价模型 cost.known = false')
  check(statsPayload.models[0].cost.total === 0 && statsPayload.totalCost === 0, '未定价时费用为 0')
  check(statsPayload.pricedModels === 0, '未定价时 pricedModels = 0')

  // 写入单价：deepseek-flash 累计 input 100 / output 20 / cacheRead 300
  // 期望 = 100/1e6*2 + 20/1e6*8 + 300/1e6*0.5 = 0.0002 + 0.00016 + 0.00015 = 0.00051
  const savedPrices = await requestWithBody('/token-usage/prices', 'POST', {
    prices: { 'opai-ds/deepseek/deepseek-flash': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 } },
  })
  check(savedPrices.statusCode === 200, `POST /prices → ${savedPrices.statusCode}`)
  const priced = JSON.parse(savedPrices.body)
  check(priced.models[0].cost.known === true, '保存后 cost.known = true')
  check(priced.models[0].cost.total === 0.00051, `费用计算 = ${priced.models[0].cost.total}（期望 0.00051）`)
  check(priced.models[0].cost.input.cost === 0.0002, `输入分项 = ${priced.models[0].cost.input.cost}（期望 0.0002）`)
  check(priced.models[0].cost.output.cost === 0.00016, `输出分项 = ${priced.models[0].cost.output.cost}（期望 0.00016）`)
  check(priced.models[0].cost.cacheRead.cost === 0.00015, `缓存命中分项 = ${priced.models[0].cost.cacheRead.cost}（期望 0.00015）`)
  check(priced.models[0].cost.input.tokens === 100, '输入分项 tokens 不被缓存扣减（inputTokens 本就不含缓存）')
  check(priced.totalCost === 0.00051, `总费用 = ${priced.totalCost}（期望 0.00051）`)
  check(priced.pricedModels === 1, `pricedModels = ${priced.pricedModels}（期望 1）`)
  check(priced.currency === 'CNY' && priced.priceUnit === 1000000, '货币与单位标注正确（CNY / 百万 token）')

  // 只填部分单价：缺的按 0 计，但要标记 partial 供页面提示
  const partial = JSON.parse((await requestWithBody('/token-usage/prices', 'POST', { prices: { 'opai-ds/deepseek/deepseek-flash': { input: 2 } } })).body)
  check(partial.models[0].cost.partial === true, '部分定价标记 partial')
  check(partial.models[0].cost.total === 0.0002, `部分定价只计已填项 = ${partial.models[0].cost.total}（期望 0.0002）`)

  // 脏数据清洗：负数/非法值/空键都不该落进来
  const dirty = JSON.parse(
    (await requestWithBody('/token-usage/prices', 'POST', {
      prices: { bad: { input: -5 }, 'glm/glm-5.3': { input: 3, junk: 9 }, '': { input: 1 }, 'x/y': { input: 'abc' } },
    })).body,
  )
  check(JSON.stringify(dirty.prices) === JSON.stringify({ 'glm/glm-5.3': { input: 3 } }), `脏单价被清洗：${JSON.stringify(dirty.prices)}`)
  check((await requestWithBody('/token-usage/prices', 'POST', null)).statusCode === 400, '非法 body → 400')
  check(request('/token-usage/prices', 'GET').statusCode === 200, 'GET /prices → 200')

  // 清空单价：全空条目等于删除
  const cleared = JSON.parse((await requestWithBody('/token-usage/prices', 'POST', { prices: {} })).body)
  check(Object.keys(cleared.prices).length === 0 && cleared.totalCost === 0, '清空单价后费用归零')

  // 恢复一份单价，供 Client 半渲染断言用
  statsPayload = JSON.parse(
    (await requestWithBody('/token-usage/prices', 'POST', {
      prices: { 'opai-ds/deepseek/deepseek-flash': { input: 2, output: 8, cacheRead: 0.5 } },
    })).body,
  )
  check(statsPayload.totalCost === 0.00051, '单价持久化后重算一致')

  // 落盘：最后一个 effect 是 dispose 时的补写
  disposers[disposers.length - 1]()
  check(existsSync(persistPath), 'dispose 时把累计落盘')
  const onDisk = JSON.parse(readFileSync(persistPath, 'utf8'))
  check(onDisk.totals.calls === 2 && onDisk.totals.totalTokens === 480, '落盘内容与内存一致')
  check(onDisk.models['opai-ds/deepseek/deepseek-flash']?.totalTokens === 420, '落盘按 provider/model 分桶')
  check(onDisk.prices['opai-ds/deepseek/deepseek-flash']?.input === 2, '单价与累计落进同一个文件')

  // reset 只清累计，单价要保留
  const reset = request('/token-usage/reset', 'POST')
  const afterReset = JSON.parse(reset.body)
  check(reset.statusCode === 200 && afterReset.totals.calls === 0 && afterReset.totals.totalTokens === 0, 'POST /reset 清零')
  check(afterReset.models.length === 0 && afterReset.days.length === 0, 'reset 后 models / days 清空')
  check(afterReset.prices['opai-ds/deepseek/deepseek-flash']?.input === 2, 'reset 保留单价（配置不该被统计清零带走）')

} catch (error) {
  check(false, `Host 端到端失败：${error.stack}`)
} finally {
  if (existsSync(persistPath)) rmSync(persistPath)
}

// ---- 3b. 数据兜底：损坏留证 / 快照恢复 / 清零可悔 ----
/** 本区块自己 import 一次，避免依赖上一个 try 块里的作用域。 */
const mod = await import(pathToFileURL(join(dir, 'index.js')).href)
/** 起一个只用到路由与日志的最小 ctx，返回 {routes, warnings}。 */
function bootHost(persistPath) {
  const routes = new Map()
  const warnings = []
  const ctx = {
    logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
    get: () => undefined,
    on: () => {},
    effect: (callback) => {
      const disposer = callback()
      return () => (typeof disposer === 'function' ? disposer() : undefined)
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => {}
      },
    },
  }
  mod.apply(ctx, { persistPath, flushDelayMs: 0 })
  return { routes, warnings }
}

/** 直调路由（reset 是同步、prices 是 async，统一 await）。 */
async function call(app, path, method, body) {
  const response = { statusCode: 0, headers: {}, setHeader() {}, end(payload) { this.body = payload } }
  const req = {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  await app.routes.get(path).handler(req, response)
  return response.body ? JSON.parse(response.body) : null
}

/** 造一份「已经跑过一段时间」的累计文件。 */
function seedUsage(path, calls, tokens) {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      since: Date.now() - 86_400_000,
      updatedAt: Date.now(),
      totals: { calls, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: tokens },
      models: { 'p/a': { provider: 'p', model: 'a', calls, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: tokens } },
      days: {},
      prices: {},
      pricesUpdatedAt: 0,
    }, null, 2),
  )
}

try {
  // ① 清零前自动快照 → 手滑可回滚
  const resetDir = mkdtempSync(join(tmpdir(), 'dsh-tu-reset-'))
  const resetPath = join(resetDir, 'usage.json')
  seedUsage(resetPath, 39, 1581960)
  const resetApp = bootHost(resetPath)
  check((await call(resetApp, '/token-usage/stats', 'GET')).totals.calls === 39, '兜底① 读回 39 次调用')
  await call(resetApp, '/token-usage/reset', 'POST', {})
  check((await call(resetApp, '/token-usage/stats', 'GET')).totals.calls === 0, '兜底① 清零生效')
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
  seedUsage(corruptPath, 39, 1581960)
  writeFileSync(`${corruptPath}.snapshot-111`, readFileSync(corruptPath, 'utf8'))
  writeFileSync(corruptPath, '')
  const corruptApp = bootHost(corruptPath)
  const recoveredStats = await call(corruptApp, '/token-usage/stats', 'GET')
  check(recoveredStats.totals.calls === 39, `兜底② 损坏后从快照恢复 39 次（实际 ${recoveredStats.totals.calls}）`)
  check(typeof recoveredStats.restoredFrom === 'string' && recoveredStats.restoredFrom.includes('.snapshot-'), '兜底② 回报了恢复来源')
  check(typeof recoveredStats.corruptBackup === 'string', '兜底② 损坏文件被备份留证')
  check(
    readdirSync(corruptDir).some((name) => name.includes('.corrupt-')),
    '兜底② 目录里能看到损坏备份（数据没丢）',
  )
  check(corruptApp.warnings.some((message) => message.includes('从快照恢复')), '兜底② 打了恢复日志')
  rmSync(corruptDir, { recursive: true, force: true })

  // ③ 主文件被误删 → 也能从快照救回
  const goneDir = mkdtempSync(join(tmpdir(), 'dsh-tu-gone-'))
  const gonePath = join(goneDir, 'usage.json')
  seedUsage(gonePath, 12, 5000)
  writeFileSync(`${gonePath}.snapshot-222`, readFileSync(gonePath, 'utf8'))
  rmSync(gonePath, { force: true })
  check((await call(bootHost(gonePath), '/token-usage/stats', 'GET')).totals.calls === 12, '兜底③ 文件被误删时从快照救回')
  rmSync(goneDir, { recursive: true, force: true })

  // ④ 垃圾 JSON（null / 数组 / 别的用途的 JSON）不能被当成合法统计而悄悄清空
  for (const [label, content] of [['null', 'null'], ['数组', '[1,2,3]'], ['无关对象', '{"foo":"bar"}']]) {
    const junkDir = mkdtempSync(join(tmpdir(), 'dsh-tu-junk-'))
    const junkPath = join(junkDir, 'usage.json')
    writeFileSync(junkPath, content)
    const junkStats = await call(bootHost(junkPath), '/token-usage/stats', 'GET')
    check(junkStats.corruptBackup !== undefined, `兜底④ ${label} 被判为损坏并留证`)
    rmSync(junkDir, { recursive: true, force: true })
  }

  // ⑤ 快照数量封顶，不会把磁盘写爆
  const pruneDir = mkdtempSync(join(tmpdir(), 'dsh-tu-prune-'))
  const prunePath = join(pruneDir, 'usage.json')
  for (let index = 0; index < 8; index += 1) {
    seedUsage(prunePath, index + 1, (index + 1) * 100)
    await call(bootHost(prunePath), '/token-usage/reset', 'POST', {})
  }
  const snapCount = readdirSync(pruneDir).filter((name) => name.includes('.snapshot-')).length
  check(snapCount <= 5, `兜底⑤ 快照封顶 5 份：实际 ${snapCount}`)
  check(!readdirSync(pruneDir).some((name) => name.endsWith('.tmp')), '兜底⑥ 写盘不留 .tmp 残留')
  rmSync(pruneDir, { recursive: true, force: true })

  // ⑦ 旧代码自查：改了 index.js 但没重启时，必须能看出来（否则「新功能不生效」无从排查）
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
      effect: (cb) => { const d = cb(); return () => d?.() },
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
} catch (error) {
  check(false, `数据兜底验证失败：${error.stack}`)
}

// ---- 3. Client 半：真渲染 ----
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
// 时钟每次前进 700ms，让 count-up 动画一步到位；rAF 同步回调即可终止。
const realNow = Date.now
let clock = realNow()
Date.now = () => (clock += 700)
globalThis.requestAnimationFrame = (callback) => {
  callback(clock)
  return 0
}
globalThis.cancelAnimationFrame = () => {}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => statsPayload })

try {
  check(statsPayload !== null, '拿到 Host 的真实 stats payload，用于渲染')
  await import(pathToFileURL(join(dir, 'client.js')).href)
  check(loaded !== null, 'client.js 调用了 window.__ModuleLoader__.load')
  check(loaded?.id === '@local/dsh-token-usage', `client.js 注册 id = ${loaded?.id}`)

  const { React, renderComponent } = createFakeReact()
  const mod = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`client.js 只应 require('react')，实际请求了 ${name}`)
  })
  check(typeof mod.apply === 'function', 'client.js 工厂返回 apply')
  check(Array.isArray(mod.inject) && mod.inject.includes('slots') && mod.inject.includes('locale'), `client.js inject = ${mod.inject}`)

  const registered = []
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dicts) => {
        if (!dicts.zh?.nav || !dicts.en?.nav) throw new Error('语言表缺少 nav')
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
  mod.apply(ctx)
  const Section = registered.find((entry) => typeof entry === 'function')
  check(typeof Section === 'function', 'settings.section 注册了组件')

  // 渲染多轮：第 1 轮 loading，fetch 落定后第 2、3 轮拿到数据（第 3 轮 count-up 到位）
  let tree = null
  for (let round = 0; round < 4; round += 1) {
    tree = renderComponent(Section, { close: () => {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const nodes = collect(tree, [], renderComponent)
  if (process.env.DSH_SMOKE_DEBUG) {
    console.log(`[debug] classNames: ${[...new Set(nodes.map(classOf).filter(Boolean))].sort().join(' ')}`)
    const describe = (node) => (typeof node === 'object' && node !== null ? `${String(node.type)}.${classOf(node) || '-'}[${(node.children ?? []).map(describe).join('|')}]` : JSON.stringify(node))
    for (const row of nodes.filter((node) => node.type === 'tr')) console.log(`[debug] ${describe(row)}`)
  }
  const bars = nodes.filter((node) => hasClass(node, 'dshtu-bar'))
  const totalNode = nodes.find((node) => hasClass(node, 'dshtu-total'))
  const legend = nodes.filter((node) => hasClass(node, 'dshtu-legend-item'))
  const toneNodes = nodes.filter((node) => /dshtu-tone-(brand|success|warn|idle|muted)/.test(classOf(node)))
  const shares = nodes.filter((node) => hasClass(node, 'dshtu-share'))
  const rows = nodes.filter((node) => node.type === 'tr')
  const modelName = nodes.find((node) => hasClass(node, 'dshtu-model-name'))
  const badge = nodes.find((node) => hasClass(node, 'dshtu-badge'))
  const ring = nodes.find((node) => hasClass(node, 'dshtu-ring-num'))
  const headerTexts = nodes.filter((node) => node.type === 'th').map((node) => String(node.children?.[0]))
  const css = nodes.filter((node) => node.type === 'style').map((node) => String(node.children?.[0] ?? '')).join('')
  const expectedTotal = Math.round(statsPayload.totals.totalTokens).toLocaleString()

  check(bars.length === 14, `趋势图默认 14 根柱：${bars.length}`)
  check(bars.some((bar) => hasClass(bar, 'dshtu-bar-today')), '今天的柱子被高亮')
  check(String(totalNode?.children?.[0]) === expectedTotal, `主视觉数字 = ${expectedTotal}（实际 ${String(totalNode?.children?.[0])}）`)
  check(legend.length >= 3, `构成图例 >= 3 项：${legend.length}`)
  check(toneNodes.length >= 3, `构成色块已着色：${toneNodes.length}`)
  check(String(ring?.children?.[0] ?? '').endsWith('%'), `缓存命中率圆环：${String(ring?.children?.[0])}`)
  check(shares.length === statsPayload.models.length, `按模型占比条 ${statsPayload.models.length} 行：${shares.length}`)
  // 三张表：按模型（1 表头 + N 行）、单价编辑（1 表头 + N 行）、按天（1 表头 + 7 行）
  const expectedRows = 3 + statsPayload.models.length * 2 + Math.min(7, statsPayload.days.length)
  check(rows.length === expectedRows, `表格总行数：${rows.length}（期望 ${expectedRows}）`)
  check(String(modelName?.children?.[0] ?? '').length > 0, `模型名：${String(modelName?.children?.[0])}`)
  check(badge !== undefined, `provider 徽标：${String(badge?.children?.[0])}`)
  check(headerTexts.includes('model') && headerTexts.includes('day') && headerTexts.filter((text) => text === 'calls').length === 2, `表头含模型/日期/调用次数：${headerTexts.join(',')}`)
  check(!/dshtu-[\w-]*\s*\{[^}]*:\s*#/.test(css), '样式无硬编码十六进制颜色')
  check(css.includes('--dsw-alias-'), '样式使用宿主主题 token')

  // ---- 费用与单价界面 ----
  const costNum = nodes.find((node) => hasClass(node, 'dshtu-cost-num'))
  const costItems = nodes.filter((node) => hasClass(node, 'dshtu-cost-item'))
  const priceInputs = nodes.filter((node) => hasClass(node, 'dshtu-price-input'))
  const saveButton = nodes.find((node) => hasClass(node, 'dshtu-btn') && hasClass(node, 'is-primary'))
  check(costNum !== undefined, '渲染了总费用数字')
  check(String(costNum?.children?.[0] ?? '').startsWith('¥'), `总费用带 ¥ 前缀：${String(costNum?.children?.[0])}`)
  check(costItems.length === 4, `费用分项 4 项：${costItems.length}`)
  check(priceInputs.length === statsPayload.models.length * 4, `单价输入框 = 模型数 × 4：${priceInputs.length}`)
  // glm 没有单价 → 四个框全空；deepseek-flash 只填了三项 → 第四个（cacheWrite）也空。
  const emptyInputs = priceInputs.filter((input) => input.props?.value === '')
  check(emptyInputs.length === statsPayload.models.length + 3, `空白单价框 ${emptyInputs.length} 个（未定价模型 4 个 + 已定价模型漏填的 1 个）`)
  check(
    priceInputs.slice(4).every((input) => input.props?.value === ''),
    '未定价的那个模型四个输入框都是空的',
  )
  check(
    priceInputs.some((input) => input.props?.value === '2'),
    '已保存的输入单价回填进输入框',
  )
  check(priceInputs.every((input) => input.props?.type === 'number' && input.props?.min === '0'), '单价输入框是受约束的 number')
  check(String(saveButton?.children?.[0] ?? '').includes('save'), `保存按钮存在：${String(saveButton?.children?.[0])}`)
  check(headerTexts.includes('cost'), '按模型表出现 cost 列（有模型定价时才出现）')
  check(nodes.some((node) => classOf(node).includes('dshtu-cost-item')), '费用分项已着色')
  // 代码版本与「跑的是不是旧代码」自查
  check(typeof statsPayload.build === 'number' && statsPayload.build > 0, `stats 回报代码版本：build ${statsPayload.build}`)
  check(statsPayload.staleSince === undefined || statsPayload.staleSince === null, '刚写完的代码不该被判为过期')
  check(
    !nodes.some((node) => hasClass(node, 'dshtu-banner')),
    '代码不过期时不显示「旧版代码」横幅',
  )
  // 数据兜底提示：smoke 的 statsPayload 是干净数据，所以这些提示不该出现（避免平时占地方）
  const noticeTexts = nodes.filter((node) => hasClass(node, 'dshtu-note')).map((node) => String(node.children?.[0] ?? ''))
  check(!noticeTexts.some((text) => text.includes('corruptBackup')), '数据正常时不显示损坏提示')
  check(!noticeTexts.some((text) => text.includes('restoredFrom')), '数据正常时不显示恢复提示')
  check(!noticeTexts.some((text) => text.includes('resetBackup')), '数据正常时不显示清零快照提示')

} catch (error) {
  check(false, `client.js 渲染失败：${error.stack}`)
} finally {
  Date.now = realNow
}

console.log(failed === 0 ? '\n烟测通过' : `\n烟测失败：${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
