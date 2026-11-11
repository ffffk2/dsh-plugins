/**
 * dsh-sysmon 的本地冒烟测试。
 *
 * Host 半：假 ctx 真跑 apply → 调真路由 → 校验指标范围、进程榜形状与降级；
 * Client 半：极简 React（支持 deps/cleanup）真渲染 → 校验悬浮前后的读数、
 * 两张榜单、样式护栏与定时器清理。
 *
 * 用法：node dsh-sysmon/smoke.mjs
 * 通过时打印 `ALL PASS`。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
let failed = 0

function check(ok, message, detail) {
  if (ok) {
    console.log(`  ok    ${message}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${message}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

function group(title) {
  console.log(`\n== ${title} ==`)
}

// ---- 1. 清单、语言文件、patch ----
group('清单与资源')
{
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(join(dir, 'locale/zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(dir, 'locale/en.json'), 'utf8'))
  check(manifest.name === '@local/dsh-sysmon', `包名 = ${manifest.name}`)
  check(manifest.exports?.['.'] === './index.js' && manifest.exports?.['./client'] === './client.js', '导出 Host / Client 两半')
  check(manifest.exports?.['./locale/*.json'] === './locale/*.json', '导出 locale 资源')
  check(JSON.stringify(manifest.dsh?.client?.inject ?? []) === JSON.stringify(['@deepseek-ai/dsh-client-ui-layout']), 'client inject 指向官方 layout 模块')
  check(manifest.dsh?.client?.platform === 'web', 'client platform = web')
  check(manifest.meta?.title === zh.meta.title && manifest.meta?.description === zh.meta.description, 'package meta 与 zh.json 一致')
  check(typeof zh.meta?.title === 'string' && zh.meta.title.length > 0, 'zh 标题非空')
  check(typeof en.meta?.title === 'string' && en.meta.title.length > 0, 'en 标题非空')
  check(zh.meta.title !== en.meta.title && zh.meta.description !== en.meta.description, '中英文案确实不同')
  const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  check(/id: sysmon/.test(patch) && patch.includes("@local/dsh-sysmon"), 'patch 插入 id=sysmon')
  const icon = readFileSync(join(dir, 'icon.svg'), 'utf8')
  check(icon.includes('viewBox="0 0 64 64"') && icon.includes('role="img"') && icon.includes('aria-label'), 'icon 为 64×64 且带可访问名')
}

// ---- 2. Host 半：真路由 ----
group('Host 路由')
const hostModule = await import(pathToFileURL(join(dir, 'index.js')).href)
let disposeHost = () => {}

try {
  check(hostModule.name === 'sysmon', `Host name = ${hostModule.name}`)
  check(typeof hostModule.apply === 'function', 'Host 导出 apply')
  check(Array.isArray(hostModule.inject) && hostModule.inject.includes('webServer'), 'Host inject 含 webServer')

  const routes = new Map()
  const effects = []
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(`WARN ${message}`) },
    get: () => undefined,
    effect(callback) {
      const disposer = callback()
      effects.push(disposer)
      return () => {}
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  hostModule.apply(ctx)
  disposeHost = () => {
    for (const disposer of effects.reverse()) {
      try {
        disposer?.()
      } catch {
        /* 卸载失败不影响断言 */
      }
    }
  }

  const request = (path, method = 'GET') =>
    new Promise((resolve) => {
      const response = {
        statusCode: 0,
        headers: {},
        setHeader(key, value) {
          this.headers[key] = value
        },
        end(body) {
          resolve({ status: this.statusCode, headers: this.headers, body })
        },
      }
      routes.get(path).handler({ method, headers: {}, url: path }, response)
    })

  check(routes.has('/sysmon/metrics') && routes.has('/sysmon/processes'), '注册了 metrics / processes 两条路由')

  const first = await request('/sysmon/metrics')
  const metrics = JSON.parse(first.body)
  check(first.status === 200, `GET /sysmon/metrics → ${first.status}`)
  check(metrics.ok === true && typeof metrics.ts === 'number', 'metrics 带 ok 与时间戳')
  check(metrics.cpu.percent >= 0 && metrics.cpu.percent <= 100, `CPU 百分比在 0–100：${metrics.cpu.percent}`)
  check(metrics.cpu.cores > 0 && metrics.cpu.windowMs >= 200, `采样窗口与核数：${metrics.cpu.windowMs}ms / ${metrics.cpu.cores} 核`)
  check(metrics.mem.total > 0 && metrics.mem.used >= 0 && metrics.mem.used <= metrics.mem.total, '内存总量/已用合理')
  check(metrics.mem.percent >= 0 && metrics.mem.percent <= 100, `内存百分比在 0–100：${metrics.mem.percent}`)
  check(first.headers['content-type']?.includes('application/json'), 'metrics content-type 是 JSON')
  check(first.headers['cache-control'] === 'no-store', 'metrics 不缓存')

  // 第二次请求走「两次请求间的差值」分支，不再等 250ms 采样窗口；
  // 差值窗口要求距上次采样 ≥1 秒，所以先等一会儿。
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const second = await request('/sysmon/metrics')
  const secondMetrics = JSON.parse(second.body)
  // 差值分支的窗口约等于两次请求的间隔；采样分支则固定约 250ms。
  check(second.status === 200 && secondMetrics.cpu.windowMs >= 900, `第二次 metrics 复用差值窗口：${secondMetrics.cpu.windowMs}ms`)
  check(secondMetrics.cpu.percent >= 0 && secondMetrics.cpu.percent <= 100, '差值分支的 CPU 百分比仍合法')

  const metricsPost = await request('/sysmon/metrics', 'POST')
  check(metricsPost.status === 405 && metricsPost.headers.allow === 'GET', 'POST /sysmon/metrics → 405 + allow: GET')

  const processResponse = await request('/sysmon/processes')
  const processes = JSON.parse(processResponse.body)
  check(processResponse.status === 200, `GET /sysmon/processes → ${processResponse.status}`)
  check(processes.available === true, '进程采样可用', processes.reason)
  check(Array.isArray(processes.cpu) && processes.cpu.length === 5, `CPU 榜 5 条：${processes.cpu?.length}`)
  check(Array.isArray(processes.mem) && processes.mem.length === 5, `内存榜 5 条：${processes.mem?.length}`)
  check(processes.processes === undefined, '不把未使用的内部字段暴露出去')
  check(processes.processCount > 5, `进程总数 = ${processes.processCount}`)
  check(processes.cores > 0 && processes.cpuMode === 'interval', '进程榜带核数与采样口径')
  const cpuValues = processes.cpu.map((row) => row.cpu)
  check(cpuValues.every((value, index) => index === 0 || cpuValues[index - 1] >= value), `CPU 榜降序：${cpuValues.join(', ')}`)
  const memValues = processes.mem.map((row) => row.mem)
  check(memValues.every((value, index) => index === 0 || memValues[index - 1] >= value), '内存榜降序')
  check(
    processes.cpu.every((row) => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(['cpu', 'mem', 'name', 'pid'])),
    '进程行只含 pid / name / cpu / mem',
    processes.cpu[0],
  )
  check(
    processes.cpu.every((row) => typeof row.name === 'string' && row.name.length > 0 && row.cpu >= 0 && row.cpu <= 100),
    '进程名字非空、CPU 在 0–100',
  )

  const cachedResponse = await request('/sysmon/processes')
  const cached = JSON.parse(cachedResponse.body)
  check(cached.available === true && cached.cached === true && cached.ageMs >= 0, '10 秒内重复请求直接复用缓存')

  const processPost = await request('/sysmon/processes', 'POST')
  check(processPost.status === 405 && processPost.headers.allow === 'GET', 'POST /sysmon/processes → 405 + allow: GET')
  check(logs.some((line) => line.includes('[sysmon] 已启用')), '启动日志打了一条')
} catch (error) {
  check(false, `Host 路由验证失败：${error.stack}`)
} finally {
  disposeHost()
}

// ---- 3. Client 半：极简 React ----
group('Client 渲染')
{
  /** 假 React：hooks 按组件类型持久化，useEffect 支持 deps 与 cleanup。 */
  function createHarness() {
    const stores = new Map()
    let active = null
    const sameDeps = (left, right) =>
      Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
    const storeFor = (type) => {
      let store = stores.get(type)
      if (store === undefined) {
        store = { cursor: 0, values: new Map(), refs: new Map(), effects: new Map(), memo: new Map() }
        stores.set(type, store)
      }
      return store
    }
    const React = {
      createElement(type, props, ...children) {
        return {
          type,
          props: props ?? {},
          children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true),
        }
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
      useEffect(effect, deps) {
        const store = active
        const index = store.cursor
        store.cursor += 1
        const previous = store.effects.get(index)
        if (previous !== undefined && sameDeps(previous.deps, deps)) return
        if (previous !== undefined && typeof previous.cleanup === 'function') {
          try {
            previous.cleanup()
          } catch {
            /* 清理失败不影响后续断言 */
          }
        }
        const cleanup = effect()
        store.effects.set(index, { deps, cleanup })
      },
      useMemo(factory, deps) {
        const store = active
        const index = store.cursor
        store.cursor += 1
        const previous = store.memo.get(index)
        if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
        const value = factory()
        store.memo.set(index, { deps, value })
        return value
      },
      useCallback(callback, deps) {
        const store = active
        const index = store.cursor
        store.cursor += 1
        const previous = store.memo.get(index)
        if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
        store.memo.set(index, { deps, value: callback })
        return callback
      },
      useRef(value) {
        const store = active
        const index = store.cursor
        store.cursor += 1
        if (!store.refs.has(index)) store.refs.set(index, { current: value })
        return store.refs.get(index)
      },
    }
    function renderComponent(type, props) {
      const store = storeFor(type)
      const previous = active
      active = store
      store.cursor = 0
      try {
        return type(props)
      } finally {
        active = previous
      }
    }
    function cleanupAll() {
      for (const store of stores.values()) {
        for (const entry of store.effects.values()) {
          if (typeof entry.cleanup === 'function') {
            try {
              entry.cleanup()
            } catch {
              /* 忽略 */
            }
          }
        }
      }
    }
    return { React, renderComponent, cleanupAll }
  }

  function collect(node, out = []) {
    if (node === null || node === undefined || node === false || node === true) return out
    if (Array.isArray(node)) {
      for (const child of node) collect(child, out)
      return out
    }
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(node)
      return out
    }
    out.push(node)
    if (typeof node.type === 'function') {
      collect(harness.renderComponent(node.type, node.props), out)
      return out
    }
    for (const child of node.children ?? []) collect(child, out)
    return out
  }

  const classOf = (node) => (typeof node === 'object' && node !== null ? String(node.props?.className ?? '') : '')
  const hasClass = (node, name) => classOf(node).split(/\s+/).includes(name)
  const textOf = (node) => (node.children ?? []).map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : '')).join('')
  const find = (nodes, name) => nodes.find((node) => hasClass(node, name))

  const metricsPayload = {
    ok: true,
    ts: Date.UTC(2026, 10, 11, 2, 34, 56),
    platform: 'win32',
    uptimeSec: 3600,
    cpu: { percent: 37.4, windowMs: 10_000, cores: 8, model: 'test' },
    mem: { total: 64 * 1024 ** 3, free: 24 * 1024 ** 3, used: 40 * 1024 ** 3, percent: 62.5 },
  }
  const processesPayload = {
    ok: true,
    available: true,
    cached: false,
    ageMs: 120,
    sampledAt: Date.UTC(2026, 10, 11, 2, 34, 56),
    cpuMode: 'interval',
    cores: 8,
    sampleMs: 700,
    processCount: 412,
    cpu: [
      { pid: 101, name: 'alpha', cpu: 42.3, mem: 512 * 1024 ** 2 },
      { pid: 102, name: 'bravo', cpu: 18, mem: 256 * 1024 ** 2 },
      { pid: 103, name: 'charlie', cpu: 9.5, mem: 128 * 1024 ** 2 },
      { pid: 104, name: 'delta', cpu: 4, mem: 64 * 1024 ** 2 },
      { pid: 105, name: 'echo', cpu: 1.2, mem: 32 * 1024 ** 2 },
    ],
    mem: [
      { pid: 201, name: 'memory-hog', cpu: 0, mem: 2 * 1024 ** 3 },
      { pid: 202, name: 'browser', cpu: 2, mem: 1536 * 1024 ** 2 },
      { pid: 203, name: 'editor', cpu: 3, mem: 1024 * 1024 ** 2 },
      { pid: 204, name: 'shell', cpu: 0.4, mem: 300 * 1024 ** 2 },
      { pid: 205, name: 'agent', cpu: 8, mem: 200 * 1024 ** 2 },
    ],
  }

  let loaded = null
  const timers = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.setInterval = (fn, ms) => {
    const record = { kind: 'interval', fn, ms, cleared: false }
    timers.push(record)
    return record
  }
  globalThis.clearInterval = (record) => {
    if (record !== null && record !== undefined) record.cleared = true
  }
  globalThis.setTimeout = (fn, ms) => {
    const record = { kind: 'timeout', fn, ms, cleared: false }
    timers.push(record)
    return record
  }
  globalThis.clearTimeout = (record) => {
    if (record !== null && record !== undefined) record.cleared = true
  }
  let fetchCount = 0
  globalThis.fetch = async (url) => {
    fetchCount += 1
    const payload = String(url).includes('/sysmon/processes') ? processesPayload : metricsPayload
    return { ok: true, status: 200, json: async () => payload }
  }
  const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0))
  const harness = createHarness()

  let moduleFace = null
  try {
    await import(pathToFileURL(join(dir, 'client.js')).href)
    check(loaded !== null, 'client.js 调用了 window.__ModuleLoader__.load')
    check(loaded?.id === '@local/dsh-sysmon', `client.js 注册 id = ${loaded?.id}`)
    moduleFace = loaded.factory((name) => {
      if (name === 'react') return harness.React
      throw new Error(`client.js 只应 require('react')，实际请求了 ${name}`)
    })
    check(typeof moduleFace.apply === 'function', '工厂返回 apply')
    check(JSON.stringify(moduleFace.inject) === JSON.stringify(['slots', 'locale']), `inject = ${moduleFace.inject}`)
  } catch (error) {
    check(false, `client.js 装载失败：${error.stack}`)
  }

  if (moduleFace !== null) {
    const state = { dictionary: null, registration: null, injectName: null }
    const ctx = {
      locale: {
        bind: () => (key) => state.dictionary?.zh?.[key] ?? key,
        register: (ns, dictionary) => {
          state.dictionary = { ns, ...dictionary }
          return () => {}
        },
      },
      slots: {
        inject: (name, callback) => {
          state.injectName = name
          callback()
        },
        register: (options, component) => {
          state.registration = { options, component }
          return () => {}
        },
      },
      effect: (callback) => {
        const disposer = callback()
        return () => disposer?.()
      },
    }
    moduleFace.apply(ctx)

    try {
      check(state.injectName === 'shell.overlay', `注册到 shell.overlay（实际 ${state.injectName}）`)
      check(state.registration?.options?.name === 'shell.overlay' && state.registration?.options?.id === 'sysmon', '槽位参数 name/id 正确')
      check(typeof state.registration?.options?.label === 'function' && state.registration.options.label() === '系统资源', 'label 是零参函数且走字典')
      check(state.dictionary?.ns === 'sysmon' && state.dictionary.zh !== undefined && state.dictionary.en !== undefined, '注册了中英字典')
      const zhKeys = Object.keys(state.dictionary.zh).sort()
      const enKeys = Object.keys(state.dictionary.en).sort()
      check(JSON.stringify(zhKeys) === JSON.stringify(enKeys), 'zh/en 键一致')
      check(zhKeys.every((key) => String(state.dictionary.zh[key]).length > 0 && String(state.dictionary.en[key]).length > 0), '没有空文案')
      check(/10/.test(state.dictionary.zh.refreshes) && /10/.test(state.dictionary.en.refreshes), '刷新节奏文案带 10 秒')

      const Component = state.registration.component
      const render = () => collect(harness.renderComponent(Component, {}), [])

      let nodes = render()
      await flush()
      nodes = render()
      const pill = find(nodes, 'dshts-pill')
      check(pill !== undefined, '渲染出左下角胶囊')
      check(find(nodes, 'dshts-panel') === undefined, '未悬停时不渲染卡片')
      check(String(pill?.props?.['aria-label'] ?? '').includes('CPU 37%'), `胶囊可访问名带读数：${pill?.props?.['aria-label']}`)
      const gauges = nodes.filter((node) => hasClass(node, 'dshts-gauge'))
      check(gauges.length === 2, `两条指标：${gauges.length}`)
      const values = nodes.filter((node) => hasClass(node, 'dshts-gauge-value')).map(textOf)
      check(JSON.stringify(values) === JSON.stringify(['37%', '63%']), `CPU/内存读数 = ${values.join(' / ')}`)

      // 悬停打开：根节点的 onMouseEnter 就是 hover 的入口。
      const hud = find(nodes, 'dshts-hud')
      check(typeof hud?.props?.onMouseEnter === 'function' && typeof hud?.props?.onMouseLeave === 'function', '根节点绑定 hover 事件')
      hud.props.onMouseEnter()
      // 第一次 render 才会跑 open 的 effect 并发请求；等请求落定后再渲染一次。
      nodes = render()
      await flush()
      nodes = render()
      const panel = find(nodes, 'dshts-panel')
      check(panel !== undefined, '悬停后渲染卡片')
      const procRows = nodes.filter((node) => hasClass(node, 'dshts-proc'))
      check(procRows.length === 10, `两张榜共 10 行：${procRows.length}`)
      const names = nodes.filter((node) => hasClass(node, 'dshts-proc-name')).map(textOf)
      check(names.slice(0, 5).join(',') === 'alpha,bravo,charlie,delta,echo', `CPU 榜进程名：${names.slice(0, 5).join(', ')}`)
      check(names.slice(5).join(',') === 'memory-hog,browser,editor,shell,agent', `内存榜进程名：${names.slice(5).join(', ')}`)
      const rowValues = nodes.filter((node) => hasClass(node, 'dshts-proc-value')).map(textOf)
      check(rowValues[0] === '42.3%' && rowValues[4] === '1.2%', `CPU 数值保留一位小数：${rowValues[0]} / ${rowValues[4]}`)
      check(rowValues[5] === '2.0 GB' && rowValues[9] === '200 MB', `内存数值按 GB/MB 显示：${rowValues[5]} / ${rowValues[9]}`)
      const panelText = collect(panel, []).filter((node) => typeof node === 'string').join('')
      check(panelText.includes('CPU 占用最高') && panelText.includes('内存占用最高'), '两张榜单标题走中文文案')
      check(panelText.includes('412 个进程') && panelText.includes('8 核'), '页脚显示进程数与核数')
      check(panelText.includes('每 10 秒刷新'), '页脚显示刷新节奏')
      check(nodes.some((node) => hasClass(node, 'dshts-dot')), '有在线状态点')
      check(!nodes.some((node) => classOf(node).includes('is-error')), '数据正常时没有错误样式')

      const intervalCount = () => timers.filter((timer) => timer.kind === 'interval' && !timer.cleared).length
      check(intervalCount() === 2, `打开时两个轮询在跑：${intervalCount()}`)

      find(nodes, 'dshts-hud').props.onMouseLeave()
      await flush()
      nodes = render()
      check(find(nodes, 'dshts-panel') === undefined, '移出后卡片收起')
      check(intervalCount() === 1, `收起后停掉进程轮询，只剩指标轮询：${intervalCount()}`)
      check(timers.every((timer) => timer.kind !== 'timeout'), '数据可用时不会安排 2 秒重试')

      harness.cleanupAll()
      check(intervalCount() === 0, '组件卸载后指标轮询也停掉')
    } catch (error) {
      check(false, `Client 渲染失败：${error.stack}`)
    }
  }

  // 样式护栏：与其它插件相同的四条硬约束。
  const css = (() => {
    const source = readFileSync(join(dir, 'client.js'), 'utf8')
    const match = /const CSS = `([\s\S]*?)`\n/.exec(source)
    return match?.[1] ?? ''
  })()
  check(css.length > 1000, `样式字符串随组件内联：${css.length} 字符`)
  check(css.includes('position:absolute') && css.includes('bottom:54px'), '浮层定位在左下角且让出侧栏页脚')
  check(!/dshts-[\w-]*[^{]*\{[^}]*:\s*#/.test(css), '无硬编码十六进制颜色')
  check(!/dshts-[\w-]*[^{]*\{[^}]*:\s*(?:rgb|hsl)a?\(/.test(css), '无硬编码 rgb()/hsl() 颜色')
  const vars = [...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1])
  const strayVars = [...new Set(vars.filter((name) => !/^--(?:dsw-alias|dsw-specific|ds-font)-/.test(name)))]
  check(strayVars.length === 0, `只引用宿主放行的 token 家族：${strayVars.join(',') || '无越界'}`)
  check(vars.length > 0, '确实用到了宿主 token')
  const classes = [...new Set([...css.matchAll(/(?<![\w-])\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]))]
  check(classes.length >= 15 && classes.every((name) => name.startsWith('dshts-')), `类名全部带 dshts- 前缀（${classes.length} 个）`)
  check(css.includes('box-sizing:border-box'), '根节点带 box-sizing reset')
  check(!css.includes('position:fixed'), '没有用 fixed 逃出浮层（布局交给 shell.overlay）')
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
