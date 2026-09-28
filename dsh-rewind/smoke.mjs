// 本机烟测：不启动 Harness，端到端跑一遍插件。
//   Host 半：假 ctx + 假 session 真跑 apply → 造真人消息触发快照 → 改工作区 → 走真路由回滚
//            → 校验表面区段替换参数、上下文剩余节点、文件还原/删除、撤销文件回滚
//   Client 半：假 React 真渲染回滚面板，用上一步真实的 points payload 断言关键节点与交互
// 用法：node smoke.mjs [插件目录]，省略时用本脚本所在目录。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = process.argv[2] ?? dirname(fileURLToPath(import.meta.url))
const POINTS_PATH = '/rewind/points'
const APPLY_PATH = '/rewind/apply'
const UNDO_FILES_PATH = '/rewind/undo-files'
let failed = 0
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`)
  if (!ok) failed += 1
}
const workspaceRoot = mkdtempSync(join(tmpdir(), 'dsh-rewind-smoke-'))
const storeRoot = join(workspaceRoot, 'store')
const projectRoot = join(workspaceRoot, 'project')
mkdirSync(join(projectRoot, 'src'), { recursive: true })

// ---- 1. 清单与语言文件 ----
for (const file of ['package.json', 'locale/zh.json', 'locale/en.json']) {
  try {
    JSON.parse(readFileSync(join(dir, file), 'utf8'))
    check(true, `json 可解析：${file}`)
  } catch (error) {
    check(false, `json 解析失败：${file} → ${error.message}`)
  }
}

/** 假 session：只实现插件用到的那部分表面折叠与事件发布。 */
function createSession(ctx, id, cwd) {
  const session = {
    id,
    header: { id, cwd, origin: 'ui', delegationDepth: 0 },
    log: [],
    surface: { nodes: [] },
    append(type, data, opts) {
      const event = { type, seq: session.log.length, time: Date.now() + session.log.length, data, ...(opts ?? {}) }
      session.log.push(event)
      const op = event.surfaceOp
      if (op === 'append') session.surface.nodes.push(event.seq)
      else if (op !== null && typeof op === 'object') {
        const start = session.surface.nodes.indexOf(op.startSeq)
        const end = session.surface.nodes.indexOf(op.endSeq)
        if (start >= 0 && end >= start) session.surface.nodes.splice(start, end - start + 1, event.seq)
      }
      for (const listener of ctx.listeners.get('session/event') ?? []) listener(session, event)
      return event
    },
  }
  return session
}

/** 假 ctx：注册监听与路由，服务按名返回。 */
function createCtx(state) {
  const listeners = new Map()
  const routes = new Map()
  const ctx = {
    listeners,
    logger: {
      info() {},
      // 插件把失败降级成 warn 日志，烟测里必须看得见，否则只能看到「超时」。
      warn: (message) => console.log(`      [host warn] ${message}`),
      error: (message) => console.log(`      [host error] ${message}`),
    },
    get(name) {
      if (name === 'sessions') {
        return {
          get: (id) => (id === state.session?.id ? state.session : undefined),
          flush: async () => {
            state.flushes += 1
            return true
          },
        }
      }
      if (name === 'sessionController') {
        return {
          resolveAgent: async (id) => {
            if (id !== state.session?.id) return { error: { code: 'session/not-found' } }
            if (state.live === false) return { error: { code: 'session/not-live' } }
            return { agent: { status: state.busy ? 'running' : 'idle', session: state.session } }
          },
        }
      }
      return undefined
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
  }
  return { ctx, routes }
}

/** 直接调用注册好的路由处理器。 */
async function callRoute(routes, path, options = {}) {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`路由未注册：${path}`)
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  const req = {
    method: options.method ?? 'GET',
    url: options.url ?? path,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    text: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(value) {
      if (value !== undefined) this.text = String(value)
    },
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: res.text === '' ? undefined : JSON.parse(res.text) }
}

/** 轮询等待某条消息的快照写好（快照在后台队列里跑）。 */
async function waitForPoint(routes, sessionId, seq, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await callRoute(routes, POINTS_PATH, { url: `${POINTS_PATH}?sessionId=${encodeURIComponent(sessionId)}` })
    const point = res.json?.points?.find((item) => item.seq === seq)
    if (point !== undefined) return point
    // DSH_SMOKE_DEBUG=1 时把落盘实况也打出来：回滚点缺失要么是索引没写，
    // 要么是写进索引后被读回时的形状校验滤掉了，两者看目录一眼就能分开。
    if (process.env.DSH_SMOKE_DEBUG && Date.now() > deadline - timeoutMs + 200) {
      const listing = []
      const walk = (path, depth) => {
        if (depth > 4) return
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          listing.push(`${path.slice(storeRoot.length) || '.'}${entry.isDirectory() ? '/' : ''}${entry.name}`)
          if (entry.isDirectory()) walk(join(path, entry.name), depth + 1)
        }
      }
      try {
        walk(storeRoot, 0)
      } catch (error) {
        listing.push(`<${error.code}>`)
      }
      console.log(`[debug] store 目录：${listing.join(' ')}`)
    }
    if (process.env.DSH_SMOKE_DEBUG) console.log(`[debug] points 响应：${JSON.stringify(res.json)}`)
    if (Date.now() > deadline) throw new Error(`等待回滚点超时：seq=${seq}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const readText = (path) => readFileSync(path, 'utf8')

let pointsPayload = null
try {
  const mod = await import(pathToFileURL(join(dir, 'index.js')).href)
  check(typeof mod.apply === 'function' && mod.name === 'rewind', 'index.js 导出 apply / name = rewind')
  check(Array.isArray(mod.inject) && mod.inject.includes('webServer'), 'index.js inject 含 webServer')

  const normalized = mod.normalizeConfig({ maxPoints: 2, restoreFiles: true })
  check(normalized.maxPoints === 2 && normalized.restoreFiles === true, 'normalizeConfig 接受合法值')
  check(normalized.keepMessage === false && normalized.maxFileBytes === 2 * 1024 * 1024, 'normalizeConfig 兜住默认值')
  check(mod.normalizeConfig({ maxPoints: -5 }).maxPoints === 1, 'maxPoints 负数被夹到下限')

  const state = { session: undefined, busy: false, live: true, flushes: 0 }
  const { ctx, routes } = createCtx(state)
  mod.apply(ctx, { root: storeRoot, restoreFiles: true, keepMessage: false })
  check(routes.has(POINTS_PATH) && routes.has(APPLY_PATH) && routes.has(UNDO_FILES_PATH), 'Host 注册了三条路由')

  // ---- 场景：S0 → 消息1（快照）→ 改文件 → 消息2（快照）→ 再改 → 回滚到消息1 ----
  const session = createSession(ctx, 'session-smoke', projectRoot)
  state.session = session
  if (process.env.DSH_SMOKE_DEBUG) console.log(`[debug] session/event 监听器：${(ctx.listeners.get('session/event') ?? []).length}`)
  writeFileSync(join(projectRoot, 'src/a.js'), 'A1')
  writeFileSync(join(projectRoot, 'README.md'), 'R')
  session.append('system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'SYS' }] } }, { surfaceOp: 'append' })
  session.append(
    'user/message',
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一问：改一下 a.js' }], source: { kind: 'user', rpcId: 'r1' } },
    { surfaceOp: 'append' },
  )
  session.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } }, { surfaceOp: 'append' })
  check(mod.isHumanPrompt(session.log[1]) === true, 'isHumanPrompt 认得界面发来的消息')
  check(mod.isHumanPrompt(session.log[0]) === false, 'isHumanPrompt 不把系统提示当人话')
  check(mod.isHumanPrompt({ type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' } } }) === false, '没有 rpcId 的 user 消息不算真人消息')
  const first = await waitForPoint(routes, session.id, 1)
  check(first?.snapshot?.state === 'ready' && first.snapshot.files === 2, `消息1 拍下 2 个文件：${JSON.stringify(first?.snapshot)}`)
  check(existsSync(join(storeRoot, 'sessions', session.id, 'snapshots', 's1', 'manifest.json')), '快照清单已落盘')

  writeFileSync(join(projectRoot, 'src/a.js'), 'A2')
  writeFileSync(join(projectRoot, 'src/b.js'), 'B')
  session.append(
    'user/message',
    { id: 'u2', role: 'user', content: [{ type: 'text', text: '第二问' }], source: { kind: 'user', rpcId: 'r2' } },
    { surfaceOp: 'append' },
  )
  await waitForPoint(routes, session.id, 3)
  writeFileSync(join(projectRoot, 'src/a.js'), 'A3')
  rmSync(join(projectRoot, 'README.md'))

  const points = await callRoute(routes, POINTS_PATH, { url: `${POINTS_PATH}?sessionId=${session.id}` })
  pointsPayload = points.json
  check(points.json?.ok === true && points.json.points.length === 2, `回滚点 2 条：${points.json?.points?.length}`)
  check(points.json.points[0].tail === 3, `一条消息之后还有 3 个表面节点：${points.json.points[0].tail}`)
  check(points.json.points[0].active === true && points.json.points[0].preview.includes('第一问'), '回滚点带摘要与在面标记')
  check(points.json.busy === false && points.json.live === true, '会话在线且空闲')

  const applied = await callRoute(routes, APPLY_PATH, { method: 'POST', body: { sessionId: session.id, seq: 1 } })
  check(applied.status === 200 && applied.json?.ok === true, `回滚成功：${JSON.stringify(applied.json?.error ?? '')}`)
  const marker = session.log[session.log.length - 1]
  check(marker.type === 'user/message' && marker.data.role === 'user', '回滚写入一条 user/message 替换节点')
  check(marker.data.content.length === 0, '默认撤回该消息本身（空 content，适配器会跳过）')
  check(marker.data.source.kind === 'rewind', `替换节点带 rewind 来源：${marker.data.source?.kind}`)
  check(marker.surfaceOp.op === 'replace' && marker.surfaceOp.startSeq === 1 && marker.surfaceOp.endSeq === 3, `替换区段 [1,3]：${JSON.stringify(marker.surfaceOp)}`)
  check(JSON.stringify(marker.sourceEventSeqs) === '[1,2,3]', `sourceEventSeqs 覆盖整段：${JSON.stringify(marker.sourceEventSeqs)}`)
  check(JSON.stringify(session.surface.nodes) === '[0,4]', `回滚后表面只剩系统提示与替换节点：${JSON.stringify(session.surface.nodes)}`)
  check(state.flushes === 1, '回滚后调用了会话落盘')
  check(applied.json.value.hiddenCount === 3 && applied.json.value.files !== null, `报告含撤回条数与文件结果：${JSON.stringify(applied.json.value.files && { r: applied.json.value.files.restored, d: applied.json.value.files.deleted })}`)
  check(readText(join(projectRoot, 'src/a.js')) === 'A1', 'a.js 被还原成快照内容')
  check(readText(join(projectRoot, 'README.md')) === 'R', '被删掉的 README.md 被找回')
  check(!existsSync(join(projectRoot, 'src/b.js')), '快照之后新建的 b.js 被删除')
  check(existsSync(join(storeRoot, 'sessions', session.id, 'snapshots', 'pre-rewind-4', 'manifest.json')), '还原前拍了安全快照')

  const after = await callRoute(routes, POINTS_PATH, { url: `${POINTS_PATH}?sessionId=${session.id}` })
  pointsPayload = after.json
  check(after.json.points.length === 1, `回滚点被裁到 1 条：${after.json.points.length}`)
  check(after.json.points[0].active === false, '被回滚的消息标记为已不在上下文中')
  check(after.json.lastRollback?.atSeq === 4 && after.json.lastRollback?.hiddenCount === 3, `记录了上一次回滚：${JSON.stringify(after.json.lastRollback)}`)
  check(!existsSync(join(storeRoot, 'sessions', session.id, 'snapshots', 's3')), '被回滚掉的快照已清理')

  const undone = await callRoute(routes, UNDO_FILES_PATH, { method: 'POST', body: { sessionId: session.id } })
  check(undone.status === 200 && undone.json?.ok === true, '撤销文件回滚成功')
  check(readText(join(projectRoot, 'src/a.js')) === 'A3', 'a.js 回到回滚前的 A3')
  check(readText(join(projectRoot, 'src/b.js')) === 'B', 'b.js 被重新写回')
  check(!existsSync(join(projectRoot, 'README.md')), 'README.md 回到「已删除」的状态')
  const stale = await callRoute(routes, UNDO_FILES_PATH, { method: 'POST', body: { sessionId: session.id } })
  check(stale.status === 409 && stale.json?.error?.code === 'no-rollback', `撤销不可重复：${stale.json?.error?.code}`)

  // ---- keepMessage：上下文停在「这条消息刚发出」 ----
  const kept = createSession(ctx, 'session-keep', projectRoot)
  state.session = kept
  kept.append('system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'SYS' }] } }, { surfaceOp: 'append' })
  kept.append(
    'user/message',
    { id: 'k1', role: 'user', content: [{ type: 'text', text: '保留我' }], source: { kind: 'user', rpcId: 'r9' } },
    { surfaceOp: 'append' },
  )
  await waitForPoint(routes, kept.id, 1)
  const keptApply = await callRoute(routes, APPLY_PATH, { method: 'POST', body: { sessionId: kept.id, seq: 1, keepMessage: true, restoreFiles: false } })
  check(keptApply.json?.ok === true, `keepMessage 回滚成功：${JSON.stringify(keptApply.json?.error ?? '')}`)
  const keptMarker = kept.log[kept.log.length - 1]
  check(keptMarker.data.content.length === 1 && keptMarker.data.content[0].text === '保留我', 'keepMessage 复制了原文')
  check(keptMarker.surfaceOp.startSeq === 1 && keptMarker.surfaceOp.endSeq === 1, `keepMessage 区段 [1,1]：${JSON.stringify(keptMarker.surfaceOp)}`)

  // ---- 投影脱节：只停用可疑的回滚点，绝不按算不准的区段去截断 ----
  const broken = createSession(ctx, 'session-broken', projectRoot)
  state.session = broken
  broken.append('system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'SYS' }] } }, { surfaceOp: 'append' })
  broken.append(
    'user/message',
    { id: 'b1', role: 'user', content: [{ type: 'text', text: '会被脱节影响' }], source: { kind: 'user', rpcId: 'rb' } },
    { surfaceOp: 'append' },
  )
  await waitForPoint(routes, broken.id, 1)
  // 一条指向不存在节点的替换：官方表面不会这样出现，但投影必须自认不可信。
  broken.append(
    'user/message',
    { id: 'b2', role: 'user', content: [], source: { kind: 'rewind', fromSeq: 999 } },
    { surfaceOp: { op: 'replace', startSeq: 999, endSeq: 999 }, sourceEventSeqs: [1] },
  )
  const brokenRes = await callRoute(routes, POINTS_PATH, { url: `${POINTS_PATH}?sessionId=${broken.id}` })
  check(
    brokenRes.json.points.every((point) => point.active === false && point.tail === undefined),
    `投影脱节后不再声称能回滚：${JSON.stringify(brokenRes.json.points.map((point) => [point.active, point.tail]))}`,
  )
  const brokenApply = await callRoute(routes, APPLY_PATH, { method: 'POST', body: { sessionId: broken.id, seq: 1, restoreFiles: false } })
  check(brokenApply.status === 409 && brokenApply.json?.error?.code === 'not-on-surface', `脱节时拒绝回滚：${brokenApply.json?.error?.code}`)
  state.session = kept

  // ---- 忙碌 / 未激活 / 过期消息的拒绝路径 ----
  state.busy = true
  const busy = await callRoute(routes, APPLY_PATH, { method: 'POST', body: { sessionId: kept.id, seq: 1 } })
  check(busy.status === 409 && busy.json?.error?.code === 'agent-busy', `回合进行中拒绝回滚：${busy.json?.error?.code}`)
  state.busy = false
  state.live = false
  const cold = await callRoute(routes, APPLY_PATH, { method: 'POST', body: { sessionId: 'session-none', seq: 0 } })
  check(cold.status === 409 && cold.json?.error?.code === 'session-not-live', `会话未激活拒绝回滚：${cold.json?.error?.code}`)
  state.live = true
  const gone = await callRoute(routes, APPLY_PATH, { method: 'POST', body: { sessionId: kept.id, seq: 99 } })
  check(gone.status === 409 && gone.json?.error?.code === 'not-on-surface', `不在表面上的消息拒绝回滚：${gone.json?.error?.code}`)
  const badBody = await callRoute(routes, APPLY_PATH, { method: 'POST', body: {} })
  check(badBody.status === 400, `缺参数回 400：${badBody.status}`)
  const wrongMethod = await callRoute(routes, APPLY_PATH, {})
  check(wrongMethod.status === 405, `GET 走 apply 回 405：${wrongMethod.status}`)
  const noQuery = await callRoute(routes, POINTS_PATH, {})
  check(noQuery.status === 400, `points 缺 sessionId 回 400：${noQuery.status}`)
  const methodOnPoints = await callRoute(routes, POINTS_PATH, { method: 'POST', url: `${POINTS_PATH}?sessionId=${session.id}` })
  check(methodOnPoints.status === 405, `POST 走 points 回 405：${methodOnPoints.status}`)
} catch (error) {
  check(false, `Host 半跑失败：${error.stack}`)
}

// ---- 2. Client 半：假 React 真渲染 ----
/** 极简 React：够本组件用（useState 跨轮保留、useEffect 立即执行）。 */
function createFakeReact() {
  let active = null
  const stores = new Map()
  const enter = (type) => {
    const previous = active
    if (!stores.has(type)) stores.set(type, { cursor: 0, values: new Map() })
    active = stores.get(type)
    active.cursor = 0
    return previous
  }
  const React = {
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
    useEffect(effect) {
      const cleanup = effect()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    useRef(initial) {
      const store = active
      const index = store.cursor
      store.cursor += 1
      if (!store.values.has(index)) store.values.set(index, { current: initial })
      return store.values.get(index)
    },
  }
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
const postCalls = []
// 组件用 setInterval 做静默轮询；烟测里换成空实现，否则定时器会吊住进程。
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload })
globalThis.fetch = async (url, init) => {
  if (init?.method === 'POST') {
    postCalls.push({ url, body: JSON.parse(init.body) })
    return jsonResponse({ ok: true, value: { markerSeq: 9, hiddenCount: 3, keepMessage: false, files: { restored: ['src/a.js'], deleted: ['src/b.js'], skipped: [], files: 2 }, warnings: [] } })
  }
  return jsonResponse(pointsPayload ?? { ok: true, points: [] })
}

try {
  check(pointsPayload !== null, '拿到 Host 真实 points payload，用于渲染')
  await import(pathToFileURL(join(dir, 'client.js')).href)
  check(loaded !== null, 'client.js 调用了 window.__ModuleLoader__.load')
  check(loaded?.id === '@local/dsh-rewind', `client.js 注册 id = ${loaded?.id}`)

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
        if (!dicts.zh?.open || !dicts.en?.open) throw new Error('语言表缺少 open')
        if (!dicts.zh?.confirm || !dicts.en?.confirm) throw new Error('语言表缺少 confirm')
        return () => {}
      },
    },
    slots: {
      inject: (key, callback) => {
        if (key !== 'conversation.input.dock') throw new Error(`slot key 异常：${key}`)
        registered.push(callback())
        return () => {}
      },
      register: (options, component) => {
        if (options.name !== 'conversation.input.dock' || options.id !== 'rewind') throw new Error('slot 注册参数异常')
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
  const Dock = registered.find((entry) => typeof entry === 'function')
  check(typeof Dock === 'function', 'conversation.input.dock 注册了组件')

  const readTree = async (rounds = 3) => {
    let tree = null
    for (let round = 0; round < rounds; round += 1) {
      tree = renderComponent(Dock, { sessionId: 'session-smoke' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return collect(tree, [], renderComponent)
  }

  let nodes = await readTree()
  const findText = (text) => nodes.find((node) => node.children?.includes(text))
  check(findText('open') !== undefined, '收起态渲染「回滚对话」按钮')
  check(findText('title') === undefined, '收起态不渲染面板')
  check(findText('hover') === undefined, '收起态没有多余文本')

  const openButton = nodes.find((node) => node.children?.includes('open'))
  openButton.props.onClick()
  nodes = await readTree()
  check(findText('title') !== undefined, '展开后渲染面板标题')
  const rows = nodes.filter((node) => hasClass(node, 'dshrw-row'))
  check(rows.length === (pointsPayload?.points?.length ?? 0), `按真实 payload 渲染回滚点行：${rows.length}`)
  const preview = nodes.filter((node) => hasClass(node, 'dshrw-preview')).map((node) => String(node.children?.[0] ?? ''))
  check(preview.some((text) => text.includes('第一问')), `行内显示消息摘要：${preview.join(' | ')}`)
  check(nodes.some((node) => hasClass(node, 'dshrw-inactive')), '已失效的回滚点被标注')
  check(findText('irreversible') === undefined, '未点开确认前不显示「不可撤销」提示')

  const backButton = nodes.find((node) => node.children?.includes('rowBack'))
  check(backButton !== undefined, '每行有「回到此处」按钮')
  backButton.props.onClick()
  nodes = await readTree()
  check(findText('confirm') !== undefined, '点开后出现确认按钮')
  check(findText('irreversible') !== undefined, '确认区给出「不可撤销」提示')
  const checkbox = nodes.find((node) => node.type === 'input')
  checkbox.props.onChange({ target: { checked: true } })
  const confirmButton = nodes.find((node) => node.children?.includes('confirm'))
  await confirmButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  check(postCalls.length === 1 && postCalls[0].url === APPLY_PATH, `确认后 POST 到 ${APPLY_PATH}：${postCalls[0]?.url}`)
  check(postCalls[0]?.body.sessionId === 'session-smoke' && Number.isSafeInteger(postCalls[0]?.body.seq), `请求体带 sessionId/seq：${JSON.stringify(postCalls[0]?.body)}`)
  check(postCalls[0]?.body.keepMessage === true || postCalls[0]?.body.keepMessage === false, '请求体带 keepMessage')

  nodes = await readTree(2)
  const undoButton = nodes.find((node) => node.children?.includes('undoFiles'))
  check(undoButton !== undefined, '有安全快照时显示「撤销文件回滚」')
  if (undoButton !== undefined) {
    await undoButton.props.onClick()
    check(postCalls.some((call) => call.url === UNDO_FILES_PATH), `撤销走 POST ${UNDO_FILES_PATH}`)
  }

  const css = nodes.filter((node) => node.type === 'style').map((node) => String(node.children?.[0] ?? '')).join('')
  check(css.includes('--dsw-alias-'), '样式使用宿主主题 token')
  check(!/:\s*#[0-9a-fA-F]{3,8}\b/.test(css), '样式无硬编码十六进制颜色')
  check(!/dshrw-[\w-]*\s*\{[^}]*rgb\(/.test(css), '样式无硬编码 rgb 颜色')
} catch (error) {
  check(false, `client.js 渲染失败：${error.stack}`)
} finally {
  rmSync(workspaceRoot, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n烟测通过' : `\n烟测失败：${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
