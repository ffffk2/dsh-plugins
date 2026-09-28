// 本机烟测：不启动 Harness，端到端跑一遍插件。
//   Host 半：假 ctx 真跑 apply → 灌 mock usage 流 → 走真路由取 stats → 校验累计/落盘/清零
//   Client 半：假 React 真渲染页面，用上一步的真实 stats payload 断言关键节点
// 用法：node smoke.mjs [插件目录]，省略时用本脚本所在目录。
import { existsSync, readFileSync, rmSync } from 'node:fs'
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

  // 落盘：最后一个 effect 是 dispose 时的补写
  disposers[disposers.length - 1]()
  check(existsSync(persistPath), 'dispose 时把累计落盘')
  const onDisk = JSON.parse(readFileSync(persistPath, 'utf8'))
  check(onDisk.totals.calls === 2 && onDisk.totals.totalTokens === 480, '落盘内容与内存一致')
  check(onDisk.models['opai-ds/deepseek/deepseek-flash']?.totalTokens === 420, '落盘按 provider/model 分桶')

  const reset = request('/token-usage/reset', 'POST')
  const afterReset = JSON.parse(reset.body)
  check(reset.statusCode === 200 && afterReset.totals.calls === 0 && afterReset.totals.totalTokens === 0, 'POST /reset 清零')
  check(afterReset.models.length === 0 && afterReset.days.length === 0, 'reset 后 models / days 清空')
} catch (error) {
  check(false, `Host 端到端失败：${error.stack}`)
} finally {
  if (existsSync(persistPath)) rmSync(persistPath)
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
  check(rows.length === 2 + statsPayload.models.length + Math.min(7, statsPayload.days.length), `表格总行数：${rows.length}`)
  check(String(modelName?.children?.[0] ?? '').length > 0, `模型名：${String(modelName?.children?.[0])}`)
  check(badge !== undefined, `provider 徽标：${String(badge?.children?.[0])}`)
  check(headerTexts.includes('model') && headerTexts.includes('day') && headerTexts.filter((text) => text === 'calls').length === 2, `表头含模型/日期/调用次数：${headerTexts.join(',')}`)
  check(!/dshtu-[\w-]*\s*\{[^}]*:\s*#/.test(css), '样式无硬编码十六进制颜色')
  check(css.includes('--dsw-alias-'), '样式使用宿主主题 token')
} catch (error) {
  check(false, `client.js 渲染失败：${error.stack}`)
} finally {
  Date.now = realNow
}

console.log(failed === 0 ? '\n烟测通过' : `\n烟测失败：${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
