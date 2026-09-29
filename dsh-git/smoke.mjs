/**
 * dsh-git 的本地冒烟测试。
 *
 * 两半都测：
 *   - Host：解析器（porcelain -z / log 字段流）、路径闸门、以及真的对**临时 git 仓库**
 *     跑一遍 status/diff/log/branches/写操作，确认路由背后的逻辑可用。
 *   - Client：在 Node 里用极简 React 真跑注册契约（sidebarRightTabs + 两个 slot），
 *     并对渲染出的 HTML 做断言：主题 token 着色、无硬编码颜色、zh/en 字典齐全。
 *
 * 退出码 0 才算过。脚本与 cwd 无关（路径基于 import.meta.url）。
 * DSH_SMOKE_DEBUG=1 会打印渲染出的 class 摘要，排错时用。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'

const CLIENT = new URL('./client.js', import.meta.url)
const HOST = new URL('./index.js', import.meta.url)
const DEBUG = process.env.DSH_SMOKE_DEBUG === '1'
const PREFIX = 'dshg-'

let failures = 0
function group(title) {
  console.log(`\n== ${title} ==`)
}
function expect(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`)
    return true
  }
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  failures += 1
  return false
}

// ---------- 极简 React ----------
// 说明：hooks 数组在「同一次组件实例的多次 render」之间必须保持，
// 否则 useState 每次都会被重新初始化，异步落定的数据就永远渲染不出来。
// 所以这里区分「顶层 render 调用」（resetHooks）与「子组件递归」（另开一份 hooks）。
let hooks = []
let hookIndex = 0
let handlers = []
/** 顶层渲染入口要调它：把 hook 状态重置成全新实例。 */
function resetHooks() {
  hooks = []
  hookIndex = 0
}

function flatten(list) {
  const out = []
  for (const item of list) {
    if (Array.isArray(item)) out.push(...flatten(item))
    else if (item !== null && item !== undefined && item !== false && item !== true) out.push(item)
  }
  return out
}

/** 依赖数组的浅比较，和 React 的判定一致（含「没传 deps 视为每次都变」）。 */
function sameDeps(previous, next) {
  if (previous === undefined || !Array.isArray(previous) || !Array.isArray(next)) return false
  if (previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: flatten(children) }
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = hookIndex++
    // 关键：把「写入」绑到当前正在渲染的那个数组对象上（slot），
    // 而不是闭包捕获 hooks 变量本身——重渲染时会换成 rootHooks，
    // 若闭包捕获变量，setState 就会写进已经废弃的旧数组，值永远渲染不出来。
    const slot = hooks
    if (slot.length <= index) slot[index] = typeof initial === 'function' ? initial() : initial
    return [
      slot[index],
      (next) => {
        slot[index] = typeof next === 'function' ? next(slot[index]) : next
      },
    ]
  },
  useEffect(fn, deps) {
    const index = hookIndex++
    const slot = hooks
    // 依赖数组按浅比较决定要不要重跑，跟真实 React 一致：
    // 组件里「切到某个页签才去拉数据」这类 effect 全靠它，不实现的话
    // 那些分支在测试里永远走不到。
    const previous = slot[index]
    if (sameDeps(previous?.deps, deps)) return
    slot[index] = { deps, cleanup: undefined }
    // 副作用返回的清理函数先记下，下次重跑前调用。
    if (typeof previous?.cleanup === 'function') previous.cleanup()
    const result = fn()
    if (typeof result === 'function') slot[index].cleanup = result
  },
  // useMemo / useCallback 必须按依赖数组决定要不要重算，跟真实 React 一致。
  // 早先只算一次就永久缓存，于是「依赖变了但值没更新」——比如贮藏下拉框选中
  // 某条之后，用 useMemo 派生的 selectedStash 永远停在 null，按钮一直是禁用的。
  // 那种情况下测试会误报产品有问题，实际是替身不够真。
  useMemo(fn, deps) {
    const index = hookIndex++
    const slot = hooks
    const previous = slot[index]
    const changed = previous === undefined || !sameDeps(previous.deps, deps)
    if (changed) slot[index] = { value: fn(), deps }
    return slot[index].value
  },
  useCallback(fn, deps) {
    const index = hookIndex++
    const slot = hooks
    const previous = slot[index]
    const changed = previous === undefined || !sameDeps(previous.deps, deps)
    if (changed) slot[index] = { value: fn, deps }
    return slot[index].value
  },
  useRef(value) {
    const index = hookIndex++
    const slot = hooks
    if (slot.length <= index) slot[index] = { current: value }
    return slot[index]
  },
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 收集一个元素子树里的纯文本，用来按文案找按钮。 */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.children)
  return ''
}

/** 当前渲染所属的极简 DOM（由 loadPlugin 建好），以及本次渲染的 DOM 挂载点。 */
let currentDom = null
let domParent = null

/** 递归把一棵子树标记成「已从文档移除」，模拟 React 卸载。 */
function markDisconnected(element) {
  element.isConnected = false
  for (const child of element.children ?? []) markDisconnected(child)
}

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(render).join('')
  const { type, props, children } = node
  if (type === React.Fragment) return render(children)
  if (typeof type === 'function') {
    const savedHooks = hooks
    const savedIndex = hookIndex
    // 每个组件实例一份独立 hook 状态：
    //   - 顶层组件（activeRoot）复用 rootHooks，让 useState 的值跨重渲染保留；
    //   - 其它组件每次全新，符合「函数组件每次渲染重新执行」的语义。
    if (type === activeRoot) {
      hooks = rootHooks
      hookIndex = 0
    } else {
      hooks = []
      hookIndex = 0
    }
    const out = type({ ...props, children: children.length > 0 ? children : undefined })
    const produced = hooks
    hooks = savedHooks
    hookIndex = savedIndex
    if (type === activeRoot) rootHooks = produced
    return render(out)
  }
  // 宿主元素：同时在极简 DOM 里建一份，供焦点逻辑使用。
  const parent = domParent
  const element = currentDom === null ? null : currentDom.createElement(String(type), parent)
  if (element !== null && typeof props.ref === 'object' && props.ref !== null) props.ref.current = element
  const attrs = []
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || name === 'ref' || value === undefined || value === null) continue
    if (name.startsWith('on') && typeof value === 'function') {
      handlers.push({ tag: type, attrs: { ...props, children }, event: name, handler: value })
      continue
    }
    if (name === 'style' && typeof value === 'object') {
      attrs.push(`style="${escapeHtml(Object.entries(value).map(([k, v]) => `${k}:${v}`).join(';'))}"`)
      continue
    }
    if (typeof value === 'function') continue
    if (value === false) continue
    if (value === true) { attrs.push(name); continue }
    attrs.push(`${name}="${escapeHtml(value)}"`)
  }
  const savedParent = domParent
  domParent = element ?? parent
  const body = render(children)
  domParent = savedParent
  if (element === null) return `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${body}</${type}>`
  element.html = `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${body}</${type}>`
  return element.html
}

/** 当前作为「实例」被反复重渲染的顶层组件；它的 hook 状态跨渲染保留。 */
let activeRoot = null
let rootHooks = []

/**
 * 挂载一个组件并返回可重复调用的 rerender 函数。
 * 模拟真实 React：状态在多次渲染之间延续，effect 只在首次执行。
 * @param component - 组件函数。
 * @param props - 初始 props。
 */
function mount(component, props) {
  activeRoot = component
  rootHooks = []
  const rerender = (nextProps) => {
    handlers = []
    hooks = rootHooks
    hookIndex = 0
    // 每轮渲染重建 DOM 树：模拟 React 卸载旧子树、挂载新子树。
    // 焦点兜底逻辑要知道「原来的焦点元素还在不在」，所以这棵树必须是真的：
    // 旧节点标记为断开并从 body 移除，否则 children 会越堆越多，
    // rootRef.current 也会指到一个早就过期的节点上。
    if (currentDom !== null) {
      for (const child of currentDom.body.children) markDisconnected(child)
      currentDom.body.children.length = 0
    }
    domParent = currentDom?.body ?? null
    const html = render(React.createElement(component, nextProps ?? props))
    rootHooks = hooks
    return html
  }
  const html = rerender(props)
  return { html, rerender }
}

// ---------- 装载 client.js ----------

/**
 * 极简 DOM：只实现插件焦点兜底逻辑用到的那几个 API。
 *
 * 为什么非要有它：client.js 的焦点逻辑全部写在 `typeof document === 'undefined'`
 * 的守卫后面。不给 document，那些分支在测试里永远走不到 —— 焦点一旦丢失就会
 * 卡死整个应用的键盘输入，这种 bug 不能靠「代码看起来对」来保证。
 *
 * 只实现被真正用到的部分，不做通用 DOM：
 *   document.activeElement / document.body、元素上的
 *   focus() / contains() / hasAttribute() / setAttribute() / isConnected。
 * 语义按浏览器来：focus() 会改 activeElement；contains() 沿 parent 链向上找。
 */
function makeDom() {
  const body = {
    tag: 'body',
    parent: null,
    attrs: new Set(),
    isConnected: true,
    children: [],
  }
  body.contains = (node) => {
    for (let cursor = node; cursor !== null && cursor !== undefined; cursor = cursor.parent) {
      if (cursor === body) return true
    }
    return false
  }
  const document = {
    activeElement: body,
    body,
    /** 记录每次 .focus()，断言「焦点被还回去了」时直接看它。 */
    focusLog: [],
    querySelectorAll: () => [],
  }
  body.focus = function focus() {
    document.activeElement = body
    document.focusLog.push('body')
  }
  /**
   * 造一个可作为面板容器的元素。
   * @param tag - 标签名，仅用于调试可读性。
   * @param parent - 父元素，默认挂在 body 下。
   */
  function createElement(tag, parent = body) {
    const element = {
      tag,
      parent,
      attrs: new Set(),
      isConnected: true,
      children: [],
    }
    element.contains = (node) => {
      for (let cursor = node; cursor !== null && cursor !== undefined; cursor = cursor.parent) {
        if (cursor === element) return true
      }
      return false
    }
    element.hasAttribute = (name) => element.attrs.has(name)
    element.setAttribute = (name, value) => {
      element.attrs.add(name)
      element.attrValues = { ...(element.attrValues ?? {}), [name]: value }
    }
    element.focus = () => {
      document.activeElement = element
      document.focusLog.push(tag)
    }
    if (parent !== null) parent.children.push(element)
    return element
  }
  return { document, body, createElement }
}

function loadPlugin() {
  let captured = null
  const sandboxWindow = {
    __ModuleLoader__: { load: (definition) => { captured = definition } },
  }
  // vm 上下文有独立的全局对象，浏览器里现成的东西它一样都没有：
  // fetch / URLSearchParams / setTimeout 都得显式给，否则组件里一用就是
  // ReferenceError，而被组件的 try/catch 吞成一句错误提示——极难排查。
  // fetch 走一层转发，这样测试里替换 globalThis.fetch 立刻生效。
  const sandboxFetch = (...args) => globalThis.fetch(...args)
  const dom = makeDom()
  const context = vm.createContext({
    window: sandboxWindow,
    document: dom.document,
    queueMicrotask,
    console,
    React,
    fetch: sandboxFetch,
    URLSearchParams,
    URL,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
  })
  context.globalThis = context
  currentDom = dom
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), context, { filename: 'client.js' })
  if (captured === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  const moduleFace = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require("${name}")`)
  })
  return { definition: captured, moduleFace, sandboxWindow, dom }
}

function makeContext() {
  const state = { registered: [], dictionaries: null, tabTypes: [], injections: [] }
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dict) => {
        state.dictionaries = { ns, dict }
        return () => {}
      },
    },
    slots: {
      inject: (name, callback) => {
        state.injections.push(name)
        callback()
        return () => {}
      },
      register: (options, component) => {
        state.registered.push({ options, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition) => {
        state.tabTypes.push(definition)
        return () => {}
      },
    },
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return { ctx, state }
}

// ---------- 用例 1：注册契约 ----------
group('Client 注册契约')
let moduleFace
/** 组件里那个 vm 沙箱自己的 window：客户端代码读的是它，不是宿主 globalThis。 */
let sandboxWindow
/** 组件所在的极简 DOM：焦点相关的回归断言直接查它。 */
let sandboxDom
{
  const loaded = loadPlugin()
  moduleFace = loaded.moduleFace
  sandboxWindow = loaded.sandboxWindow
  sandboxDom = loaded.dom
  expect('module id 与包名一致', loaded.definition.id === '@local/dsh-git', loaded.definition.id)
  expect(
    'inject 声明 slots/locale/sidebarRightTabs',
    JSON.stringify(moduleFace.inject) === JSON.stringify(['slots', 'locale', 'sidebarRightTabs']),
    moduleFace.inject,
  )

  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)

  expect('注册了 1 个 tab 类型', state.tabTypes.length === 1, state.tabTypes.length)
  const type = state.tabTypes[0] ?? {}
  expect('tab kind 是 git', type.kind === 'git', type.kind)
  expect('tab id 是包名', type.id === '@local/dsh-git', type.id)
  expect('tab 支持多开', type.multiple === true, type.multiple)
  expect('priority 是 extension（不抢占 builtin）', type.priority === 'extension', type.priority)
  expect('有 guide 入口', Array.isArray(type.guide) && type.guide.length === 1, type.guide)
  const guide = type.guide?.[0] ?? {}
  expect('guide order 排在浏览器(30)之后', guide.order === 40, guide.order)
  expect('guide 的 title/description 是函数（跟随语言）', typeof guide.title === 'function' && typeof guide.description === 'function')
  expect('guide 有图标组件', typeof guide.icon === 'function')

  expect('注册了 tab 主体与标题两个 slot', state.registered.length === 2, state.registered.length)
  const body = state.registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const title = state.registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab.title')
  expect('body slot 显示 git', body?.options?.key === '@local/dsh-git', body?.options?.key)
  expect('title slot 显示 git', title?.options?.key === '@local/dsh-git', title?.options?.key)
  expect('两者都带 locale 命名空间', body?.options?.locale === 'git' && title?.options?.locale === 'git')
  expect('组件都是函数', typeof body?.component === 'function' && typeof title?.component === 'function')

  expect('字典命名空间是 git', state.dictionaries?.ns === 'git', state.dictionaries?.ns)
}

// ---------- 用例 2：字典完整性 ----------
group('中英文字典')
{
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  const dict = state.dictionaries?.dict ?? {}
  const zh = dict.zh ?? {}
  const en = dict.en ?? {}
  expect('zh 与 en 同时存在', Object.keys(zh).length > 0 && Object.keys(en).length > 0, [Object.keys(zh).length, Object.keys(en).length])
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  expect('两份字典键完全一致', JSON.stringify(zhKeys) === JSON.stringify(enKeys), {
    onlyZh: zhKeys.filter((key) => !enKeys.includes(key)),
    onlyEn: enKeys.filter((key) => !zhKeys.includes(key)),
  })
  expect('键数量够覆盖 UI', zhKeys.length >= 60, zhKeys.length)
  expect('没有空文案', Object.values(zh).every((value) => String(value).trim() !== '') && Object.values(en).every((value) => String(value).trim() !== ''))
  expect('含 tab 标题文案', zh['type.label'] === 'Git' && en['type.label'] === 'Git')
}

// ---------- 用例 3：差异解析（纯函数） ----------
group('差异解析')
{
  const { parseDiffLines, diffStat, splitPath, statusLetter } = moduleFace.__test
  const sample = [
    'diff --git a/a.txt b/a.txt',
    'index 111..222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,4 @@',
    ' keep',
    '-drop',
    '+add one',
    '+add two',
    ' tail',
  ].join('\n')
  const lines = parseDiffLines(sample)
  const stat = diffStat(lines)
  expect('解析出 2 个新增', stat.add === 2, stat)
  expect('解析出 1 个删除', stat.del === 1, stat)
  expect('hunk 头被识别', lines.some((line) => line.type === 'hunk'))
  expect('meta 行被灰掉', lines.filter((line) => line.type === 'meta').length === 4, lines.filter((line) => line.type === 'meta').length)
  const addLine = lines.find((line) => line.type === 'add')
  expect('新增行带新行号', addLine?.newNo === 2, addLine)
  const delLine = lines.find((line) => line.type === 'del')
  expect('删除行带旧行号', delLine?.oldNo === 2, delLine)
  expect('上下文行两号同步推进', lines.filter((line) => line.type === 'ctx').every((line) => Number.isInteger(line.oldNo) && Number.isInteger(line.newNo)))
  expect('空输入不炸', parseDiffLines(undefined).length === 0)
  expect('路径拆分正确', JSON.stringify(splitPath('a/b/c.txt')) === JSON.stringify({ dir: 'a/b/', name: 'c.txt' }), splitPath('a/b/c.txt'))
  expect('无目录路径', splitPath('c.txt').dir === '')
  expect('状态字母映射', statusLetter('untracked') === 'U' && statusLetter('deleted') === 'D' && statusLetter('renamed') === 'R')
}

// ---------- 用例 4：渲染（按宿主真实 props 契约） ----------
group('面板渲染')
{
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)

  const body = state.registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const title = state.registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab.title')

  /** 造一份宿主注入的 props：sessionId + useSessions + useTabInfo + t。 */
  const hostProps = (cwd, overrides = {}) => ({
    sessionId: 'sess-1',
    // 宿主注入的是快照选择器 hook：selector 收到 sessions 快照。
    useSessions: (selector) => selector({ byId: { 'sess-1': cwd === undefined ? {} : { cwd } } }),
    useTabInfo: () => ({ tab: { id: 'tab-1', actions: { bindCommands: () => () => {} } } }),
    t: (key) => key,
    ...overrides,
  })

  // (a) 会话没有工作目录 → 渲染「不是仓库」空状态（不需要 fetch）。
  let empty = ''
  try {
    empty = mount(body.component, hostProps(undefined)).html
  } catch (error) {
    expect('空状态渲染不报错', false, error.message)
  }
  expect('空状态渲染出根节点', empty.includes(`${PREFIX}root`))
  expect('空状态提示不是仓库', empty.includes('notRepo'))
  expect('空状态给出路径输入框', empty.includes(`${PREFIX}input`))

  // (b) 会话有工作目录 → 必须拿它当仓库路径去查状态。
  //     这是回归用例：曾经误用并不存在的 props.view.cwd，
  //     于是路径永远是空的、面板一律显示「当前目录不是 Git 仓库」。
  const requested = []
  const stubbed = {
    root: 'D:/demo',
    branch: 'main',
    detached: false,
    upstream: { upstream: 'origin/main', ahead: 2, behind: 1 },
    files: [
      { path: 'src/app.js', x: 'M', y: ' ', staged: true, kind: 'modified' },
      { path: 'src/new file.js', x: ' ', y: 'M', staged: false, kind: 'modified' },
      { path: 'docs/readme.md', x: '?', y: '?', staged: false, kind: 'untracked' },
    ],
    staged: [{ path: 'src/app.js', x: 'M', y: ' ', staged: true, kind: 'modified' }],
    unstaged: [
      { path: 'src/new file.js', x: ' ', y: 'M', staged: false, kind: 'modified' },
      { path: 'docs/readme.md', x: '?', y: '?', staged: false, kind: 'untracked' },
    ],
    stashes: [],
    clean: false,
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    requested.push(text)
    let payload = {}
    if (text.includes('/git/status')) payload = stubbed
    else if (text.includes('/git/diff')) payload = { file: 'src/app.js', diff: '@@ -1 +1 @@\n-old\n+new', truncated: false, error: null }
    else if (text.includes('/git/log')) payload = { commits: [], hasMore: false, error: null }
    else if (text.includes('/git/branches')) payload = { locals: [], remotes: [], error: null }
    return { ok: true, status: 200, json: async () => payload }
  }

  let html = ''
  try {
    const instance = mount(body.component, hostProps('D:/demo'))
    await new Promise((resolve) => setTimeout(resolve, 40))
    html = instance.rerender(hostProps('D:/demo'))
  } catch (error) {
    expect('主视图渲染不报错', false, error.message)
  } finally {
    globalThis.fetch = originalFetch
  }
  if (DEBUG) console.log('  主视图 html 摘要：', html.slice(0, 500))

  // 关键回归断言：会话 cwd 真的被当成仓库路径发出去了。
  expect('用会话 cwd 去查了状态', requested.some((url) => url.includes('/git/status') && url.includes(encodeURIComponent('D:/demo'))), requested.slice(0, 3))
  expect('主视图渲染出分支按钮', html.includes(`${PREFIX}branch-btn`))
  expect('渲染出分支名 main', html.includes('>main<'))
  // t() 在测试里是恒等函数，所以渲染出的就是字典键本身。
  expect('渲染出远程动作按钮', html.includes('>fetch<') && html.includes('>pull<') && html.includes('>push<'))
  expect('ahead/behind 有提示', html.includes('↑2') && html.includes('↓1'))
  expect('渲染出页签栏', html.includes(`${PREFIX}tabs`))
  expect('渲染出提交框', html.includes(`${PREFIX}textarea`))
  expect('渲染出提交按钮', html.includes(`${PREFIX}commit-actions`))
  expect('渲染出暂存分组', html.includes('stagedChanges'))
  expect('渲染出更改分组', html.includes('>changes<'))
  expect('文件行渲染出状态字母 M', (html.match(/dshg-k-modified/g) ?? []).length >= 2)
  expect('未跟踪文件用 U 字母', html.includes('>U<'))
  expect('行内暂存/取消暂存按钮都在', html.includes(`${PREFIX}file-actions`))

  // (b2) 丢弃相关：这几个是回归用例，钉住两个曾经出错的点。
  //   ① 「更改」分组旁边要有一个「全部丢弃」按钮，和「全部暂存」并排；
  //   ② 未跟踪文件的丢弃按钮必须是**删除**语义 —— 图标 ✕、标题 deleteUntracked，
  //      不能沿用已跟踪文件的 ↺ / discard。git 里未跟踪文件只能删，没有还原一说。
  expect('更改分组有「全部暂存」入口', html.includes('title="stageAll"'))
  expect('更改分组有「全部丢弃」按钮', html.includes('title="discardAll"'))
  expect('全部丢弃按钮与全部暂存并排', html.indexOf('title="discardAll"') < html.indexOf('title="stageAll"'))
  expect('未跟踪行的丢弃按钮是删除语义', html.includes('title="deleteUntracked"'))
  expect('已跟踪行的丢弃按钮仍是放弃语义', html.includes('title="discard"'))
  expect('未跟踪行用删除图标 ✕', html.includes('>✕<'))
  expect('已跟踪行用还原图标 ↺', html.includes('>↺<'))

  // (b3) 点「全部丢弃」→ 必须带上确认，且确认后发出 discard-all 动作。
  //      用 DSH_SMOKE_DEBUG=1 可以看到渲染出的 html。
  const discardAllButton = handlers.find((entry) => entry.event === 'onClick' && entry.attrs.title === 'discardAll')
  expect('找得到全部丢弃按钮的点击处理器', discardAllButton !== undefined)
  let prompted = ''
  const originalConfirm = sandboxWindow.confirm
  if (discardAllButton !== undefined) {
    const posts = []
    globalThis.fetch = async (url, init) => {
      const text = String(url)
      requested.push(text)
      if (init !== undefined && init.method === 'POST') posts.push(JSON.parse(String(init.body)))
      let payload = {}
      if (text.includes('/git/status')) payload = stubbed
      else if (text.includes('/git/diff')) payload = { file: 'a.txt', diff: '', truncated: false, error: null }
      else if (text.includes('/git/log')) payload = { commits: [], hasMore: false, error: null }
      else if (text.includes('/git/branches')) payload = { locals: [], remotes: [], error: null }
      else payload = { ok: true, action: 'discard-all', status: stubbed }
      return { ok: true, status: 200, json: async () => payload }
    }
    // 客户端代码读的是 vm 沙箱里的 window，所以确认框要打在这个对象上，
    // 顺便记下提示文案；总是返回 true 表示「用户点了确定」。
    sandboxWindow.confirm = (message) => {
      prompted = String(message)
      return true
    }
    try {
      discardAllButton.handler({})
      await new Promise((resolve) => setTimeout(resolve, 30))
    } finally {
      globalThis.fetch = originalFetch
      if (originalConfirm === undefined) delete sandboxWindow.confirm
      else sandboxWindow.confirm = originalConfirm
    }
    expect('全部丢弃前先弹确认', prompted.includes('discardAllConfirm'), prompted)
    expect('确认后发出 discard-all 动作', posts.some((body) => body.action === 'discard-all'), posts)
  }

  // (b4) 贮藏区：必须能**手动选**哪一条，且「应用」与「恢复」是两个不同的动作。
  //   回归点：早先只有一个 ↑ 按钮，直接对 stashes[0] 发 stash-pop（默认弹最新一个并删除），
  //   用户既选不了、也会在「只是想应用一下」时把贮藏弄丢。
  const stashed = {
    ...stubbed,
    stashes: [
      { ref: 'stash@{0}', message: 'On main: 第二条' },
      { ref: 'stash@{1}', message: 'On main: 第一条' },
    ],
  }
  const stashPosts = []
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    requested.push(text)
    if (init !== undefined && init.method === 'POST') stashPosts.push(JSON.parse(String(init.body)))
    let payload = {}
    if (text.includes('/git/status')) payload = stashed
    else if (text.includes('/git/diff')) payload = { file: 'a.txt', diff: '', truncated: false, error: null }
    else if (text.includes('/git/log')) payload = { commits: [], hasMore: false, error: null }
    else if (text.includes('/git/branches')) payload = { locals: [], remotes: [], error: null }
    else payload = { ok: true, status: stashed }
    return { ok: true, status: 200, json: async () => payload }
  }
  let stashHtml = ''
  try {
    const instance = mount(body.component, hostProps('D:/demo'))
    await new Promise((resolve) => setTimeout(resolve, 40))
    stashHtml = instance.rerender(hostProps('D:/demo'))

    // 有贮藏时必须渲染出选择器，且两条都在里面。
    expect('渲染出贮藏选择器', stashHtml.includes(`${PREFIX}stash-select`), stashHtml.slice(0, 300))
    expect('选择器里有第一条贮藏', stashHtml.includes('stash@{0}') && stashHtml.includes('第二条'))
    expect('选择器里有第二条贮藏', stashHtml.includes('stash@{1}') && stashHtml.includes('第一条'))
    // 关键：默认值是占位项，不能预选最新那条。
    expect('贮藏选择器默认不选中任何一条', stashHtml.includes('value=""'))
    expect('渲染出应用（保留）按钮', stashHtml.includes('title="stashApply"') || stashHtml.includes('>stashApply<'))
    expect('渲染出恢复并删除按钮', stashHtml.includes('>stashPop<'))
    expect('不再有默认弹最新的裸 ↑ 按钮', stashHtml.includes('title="stashPop"') === false)

    // 未选任何一条时，三个操作按钮都应是禁用的。
    const stashButtonsBefore = handlers.filter((entry) => entry.event === 'onClick' && (entry.attrs.className ?? '').includes('dshg-btn'))
    const enabledBefore = stashButtonsBefore.filter((entry) => entry.attrs.disabled !== true)
    expect('未选贮藏时按钮禁用（提交框按钮除外）', stashButtonsBefore.length > enabledBefore.length)

    // 手动选中 stash@{1}（不是最新的那条），然后点「应用」。
    const select = handlers.find((entry) => entry.event === 'onChange' && entry.attrs['aria-label'] === 'stashPick')
    expect('找得到贮藏选择器的 onChange', select !== undefined)
    sandboxWindow.confirm = () => true
    if (select !== undefined) {
      select.handler({ target: { value: 'stash@{1}' } })
      stashHtml = instance.rerender(hostProps('D:/demo'))
      const applyButton = handlers.find((entry) => entry.event === 'onClick' && String(entry.attrs.children) === 'stashApply')
      expect('选完能拿到应用按钮', applyButton !== undefined)
      expect('选中后应用按钮可用', applyButton?.attrs.disabled === false)
      applyButton?.handler({})
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    const applyPost = stashPosts.find((body) => body.action === 'stash-apply')
    expect('应用发出的是 stash-apply（保留）而不是 stash-pop', applyPost !== undefined, stashPosts)
    expect('应用带上的是手动选中的 stash@{1}', applyPost?.name === 'stash@{1}', applyPost)
  } catch (error) {
    expect('贮藏区渲染不报错', false, error.message)
  } finally {
    globalThis.fetch = originalFetch
    delete sandboxWindow.confirm
  }

  // (b5) 焦点兜底：写操作期间面板按钮会被 disabled，浏览器随即 blur 掉持有焦点的按钮，
  //   而宿主的焦点恢复逻辑在这种「元素还在、只是被禁用」的情况下不会救场
  //   （它只看 childList 移除，且 focusout 的 relatedTarget 为 null 时会直接清掉状态）。
  //   结果就是焦点永久停在 body 上，用户「打字进不了输入框，点哪都恢复不了」。
  //   这一段钉住两件事：动作后焦点被还回面板容器；用户自己点了别处时绝不抢焦点。
  const focusStub = {
    ...stubbed,
    files: [{ path: 'a.txt', x: ' M', y: 'M', staged: false, kind: 'modified' }],
    staged: [],
    unstaged: [{ path: 'a.txt', x: ' M', y: 'M', staged: false, kind: 'modified' }],
    stashes: [],
    clean: false,
  }
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    requested.push(text)
    let payload = {}
    if (text.includes('/git/status')) payload = focusStub
    else if (text.includes('/git/diff')) payload = { file: 'a.txt', diff: '', truncated: false, error: null }
    else if (text.includes('/git/log')) payload = { commits: [], hasMore: false, error: null }
    else if (text.includes('/git/branches')) payload = { locals: [], remotes: [], error: null }
    else payload = { ok: true, status: focusStub }
    return { ok: true, status: 200, json: async () => payload }
  }
  try {
    const instance = mount(body.component, hostProps('D:/demo'))
    await new Promise((resolve) => setTimeout(resolve, 40))
    instance.rerender(hostProps('D:/demo'))

    const stageAll = handlers.find((entry) => entry.event === 'onClick' && entry.attrs.title === 'stageAll')
    expect('找得到全部暂存按钮（焦点用例）', stageAll !== undefined)
    const rootElement = sandboxDom.body.children.find((item) => String(item.tag) === 'div')
    expect('面板根容器进了 DOM 树（ref 生效）', rootElement !== undefined, sandboxDom.body.children.map((item) => item.tag))

    if (rootElement !== undefined && stageAll !== undefined) {
      // 用挂在面板根下的子元素代表「持有焦点的按钮」。
      const fakeButton = sandboxDom.createElement('button', rootElement)
      fakeButton.focus()
      sandboxDom.document.focusLog.length = 0

      stageAll.handler({})
      // 真实浏览器会在按钮变成 disabled 的那一刻 blur 它，焦点落到 body。
      // 替身不会自动做这件事，所以这里把这一步显式演出来——否则测不到真正的场景。
      sandboxDom.document.activeElement = sandboxDom.body
      await new Promise((resolve) => setTimeout(resolve, 40))

      expect('动作后焦点没有停在 body', sandboxDom.document.activeElement !== sandboxDom.body, String(sandboxDom.document.activeElement?.tag))
      expect('确实对面板容器调用过 focus()', sandboxDom.document.focusLog.includes('div'), sandboxDom.document.focusLog)
      expect('面板容器带上 tabindex=-1（可编程聚焦且不进 Tab 序列）', rootElement.hasAttribute('tabindex') === true)

      // 反向用例：用户自己把焦点放到了别处（比如会话输入框），此时绝不能被抢走。
      const elsewhere = sandboxDom.createElement('textarea', sandboxDom.body)
      instance.rerender(hostProps('D:/demo'))
      const stageAll2 = handlers.find((entry) => entry.event === 'onClick' && entry.attrs.title === 'stageAll')
      const rootElement2 = sandboxDom.body.children.find((item) => String(item.tag) === 'div')
      if (stageAll2 !== undefined && rootElement2 !== undefined) {
        // 动作开始时焦点在面板里（captureFocus 记录为 true）……
        const insideButton = sandboxDom.createElement('button', rootElement2)
        insideButton.focus()
        stageAll2.handler({})
        // ……但动作期间用户点到了面板外面。
        elsewhere.focus()
        sandboxDom.document.focusLog.length = 0
        await new Promise((resolve) => setTimeout(resolve, 40))
        expect('用户已把焦点移到面板外时不抢焦点', sandboxDom.document.activeElement === elsewhere, String(sandboxDom.document.activeElement?.tag))
      }
    }
  } catch (error) {
    expect('焦点用例不报错', false, error.message)
  } finally {
    globalThis.fetch = originalFetch
  }

  // (c) 标题槽位：渲染出名字，且不依赖任何 props.view。
  let titleHtml = ''
  try {
    titleHtml = mount(title.component, { t: (key) => key }).html
  } catch (error) {
    expect('标题渲染不报错', false, error.message)
  }
  expect('标题渲染出文案', titleHtml.includes('tabTitle'), titleHtml)

  // (d) 分支页：新建分支表单要给出「起点分支」选择，以及合并策略开关。
  //     这两个是后加的功能，用渲染断言钉住入口不会在重构里丢掉。
  const branchRequested = []
  const branchStub = {
    locals: [
      { name: 'main', hash: 'aaa', date: '2024-01-01T00:00:00+08:00', subject: 'base', upstream: 'origin/main', current: true },
      { name: 'develop', hash: 'bbb', date: '2024-01-02T00:00:00+08:00', subject: 'dev', upstream: null, current: false },
    ],
    remotes: [{ name: 'origin/main', hash: 'aaa', date: '2024-01-01T00:00:00+08:00', subject: 'base', upstream: null, current: false }],
    error: null,
  }
  globalThis.fetch = async (url) => {
    const text = String(url)
    branchRequested.push(text)
    let payload = {}
    if (text.includes('/git/status')) payload = stubbed
    else if (text.includes('/git/branches')) payload = branchStub
    else if (text.includes('/git/log')) payload = { commits: [], hasMore: false, error: null }
    else if (text.includes('/git/diff')) payload = { file: 'a', diff: '', truncated: false, error: null }
    return { ok: true, status: 200, json: async () => payload }
  }
  let branchHtml = ''
  try {
    const instance = mount(body.component, hostProps('D:/demo'))
    await new Promise((resolve) => setTimeout(resolve, 40))
    instance.rerender(hostProps('D:/demo'))
    // 切到「分支」页签：找那个 label 为 branches 的按钮并点它。
    const branchTabButton = handlers.find((entry) => entry.event === 'onClick' && String(entry.attrs.className ?? '').includes('dshg-tab') && textOf(entry.attrs.children) === 'branches')
    expect('找得到分支页签按钮', branchTabButton !== undefined)
    branchTabButton?.handler({})
    // 分支列表是异步拉的，而且要在 tab 状态生效后的那次渲染里才会被 effect 取。
    // 多渲染几轮把「点击 → 重渲染 → effect 拉数据 → 数据落 state → 再渲染」走完。
    for (let round = 0; round < 4; round += 1) {
      branchHtml = instance.rerender(hostProps('D:/demo'))
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    branchHtml = instance.rerender(hostProps('D:/demo'))
  } catch (error) {
    expect('分支页渲染不报错', false, error.message)
  } finally {
    globalThis.fetch = originalFetch
  }
  if (DEBUG) console.log('  分支页 html 摘要：', branchHtml.slice(0, 400))
  expect('分支页拉取了分支列表', branchRequested.some((url) => url.includes('/git/branches')))
  expect('分支页有新建分支按钮', branchHtml.includes('createBranch'))
  expect('分支页有合并策略开关', branchHtml.includes('mergeFastForward') || branchHtml.includes('mergeNoFf'))
  expect('分支页列出了本地分支', branchHtml.includes('develop'))
  expect('分支页列出了远程分支', branchHtml.includes('origin/main'))
  expect('非当前分支有合并按钮', branchHtml.includes('⇥'))
  expect('当前分支不显示合并/切换/删除', (branchHtml.match(/dshg-branch is-current/g) ?? []).length >= 1)

  // (e) 交互闭环：选出起点 → 建分支，断言起点真的被发给了后端。
  //     只断言「下拉框存在」是不够的——曾经把 startPoint 从请求里漏掉，
  //     界面看起来完全正常，但功能静默失效。
  const posts = []
  const originalFetch2 = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const text = String(url)
    let payload = {}
    if (text.includes('/git/status')) payload = stubbed
    else if (text.includes('/git/branches')) payload = branchStub
    else if (text.includes('/git/log')) payload = { commits: [], hasMore: false, error: null }
    if (options?.method === 'POST') posts.push(JSON.parse(options.body))
    return { ok: true, status: 200, json: async () => payload }
  }
  try {
    const instance = mount(body.component, hostProps('D:/demo'))
    for (let round = 0; round < 4; round += 1) {
      instance.rerender(hostProps('D:/demo'))
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const branchTab = handlers.find((entry) => entry.event === 'onClick' && String(entry.attrs.className ?? '').includes('dshg-tab') && textOf(entry.attrs.children) === 'branches')
    branchTab?.handler({})
    for (let round = 0; round < 4; round += 1) {
      instance.rerender(hostProps('D:/demo'))
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    // 点开新建分支表单
    const createToggle = handlers.find((entry) => entry.event === 'onClick' && textOf(entry.attrs.children) === '+ createBranch')
    expect('找得到新建分支按钮', createToggle !== undefined, textOf(createToggle?.attrs?.children))
    createToggle?.handler({})
    for (let round = 0; round < 3; round += 1) {
      instance.rerender(hostProps('D:/demo'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    // 填分支名
    const nameInput = handlers.find((entry) => entry.event === 'onChange' && entry.attrs['aria-label'] === 'newBranchPlaceholder')
    expect('找得到分支名输入框', nameInput !== undefined)

    // 空格自动转中划线：先喂一个带空格（含连续空格）的名字，
    // 断言输入框当场显示的就是规范化后的值——用户所见即最终分支名，不必等提交才知道。
    nameInput?.handler({ target: { value: 'feat  my  branch' } })
    for (let round = 0; round < 3; round += 1) {
      instance.rerender(hostProps('D:/demo'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const spacedInput = handlers.find((entry) => entry.event === 'onChange' && entry.attrs['aria-label'] === 'newBranchPlaceholder')
    expect('输入框里空格已变成中划线', spacedInput?.attrs?.value === 'feat-my-branch', JSON.stringify(spacedInput?.attrs?.value))
    expect('折叠掉连续中划线', String(spacedInput?.attrs?.value ?? '').includes('--') !== true, spacedInput?.attrs?.value)
    // 普通字符不受影响：斜杠是分层分支名的合法组成，不能被误伤。
    spacedInput?.handler({ target: { value: 'feat/new-one' } })
    for (let round = 0; round < 3; round += 1) {
      instance.rerender(hostProps('D:/demo'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const restoredInput = handlers.find((entry) => entry.event === 'onChange' && entry.attrs['aria-label'] === 'newBranchPlaceholder')
    expect('斜杠没有被误伤', restoredInput?.attrs?.value === 'feat/new-one', restoredInput?.attrs?.value)

    // 选起点（远程分支）
    const sourceSelect = handlers.find((entry) => entry.event === 'onChange' && entry.attrs['aria-label'] === 'startPoint')
    expect('找得到起点下拉框', sourceSelect !== undefined)
    sourceSelect?.handler({ target: { value: 'origin/main' } })
    for (let round = 0; round < 3; round += 1) {
      instance.rerender(hostProps('D:/demo'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    // 点「创建」
    const confirmCreate = handlers.find((entry) => entry.event === 'onClick' && textOf(entry.attrs.children) === 'create')
    expect('找得到创建按钮', confirmCreate !== undefined)
    confirmCreate?.handler({})
    await new Promise((resolve) => setTimeout(resolve, 30))

    const createPost = posts.find((entry) => entry.action === 'create-branch')
    expect('发出了 create-branch 请求', createPost !== undefined, posts.map((entry) => entry.action))
    expect('分支名进入请求', createPost?.name === 'feat/new-one', createPost)
    expect('起点分支进入请求（关键回归）', createPost?.startPoint === 'origin/main', createPost)

    // 点某个非当前分支的合并按钮，断言合并请求带上分支与策略。
    posts.length = 0
    const mergeButton = handlers.find((entry) => entry.event === 'onClick' && (entry.attrs.title ?? '').startsWith('merge '))
    expect('找得到合并按钮', mergeButton !== undefined, mergeButton?.attrs?.title)
    mergeButton?.handler({})
    await new Promise((resolve) => setTimeout(resolve, 30))
    const mergePost = posts.find((entry) => entry.action === 'merge')
    expect('发出了 merge 请求', mergePost !== undefined, posts.map((entry) => entry.action))
    expect('合并目标进入请求', mergePost?.name === 'develop', mergePost)
    expect('合并策略进入请求', mergePost?.ffOnly === true, mergePost)
  } finally {
    globalThis.fetch = originalFetch2
  }
}

// ---------- 用例 5：无硬编码颜色 + 只用宿主 token ----------
group('样式约束')
{
  const css = fs.readFileSync(CLIENT, 'utf8')
  // 取 CSS 模板串正文做检查：注释里允许出现色值说明，但不允许真的写死颜色。
  const styleBlock = css.slice(css.indexOf('const CSS = `') + 'const CSS = `'.length, css.indexOf('\n`\n\n    // ---- 纯函数工具'))
  expect('找得到 CSS 块', styleBlock.length > 500, styleBlock.length)
  const hex = styleBlock.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  expect('CSS 中没有硬编码十六进制颜色', hex.length === 0, hex)
  const rgb = styleBlock.match(/\b(?:rgb|hsl)a?\(/g) ?? []
  expect('CSS 中没有 rgb()/hsl() 字面量', rgb.length === 0, rgb)
  const named = styleBlock.match(/:\s*(?:red|blue|green|black|white|gray|grey|orange|yellow|purple)\b/g) ?? []
  expect('CSS 中没有具名颜色', named.length === 0, named)
  expect('使用了 --dsw-alias 主题 token', styleBlock.includes('--dsw-alias-'))
  const classes = styleBlock.match(/\.dshg-[a-z-]+/g) ?? []
  expect('类名统一以 dshg- 前缀', classes.length > 40, classes.length)
  expect('没有别的插件前缀混入', !styleBlock.includes('.dshtc-') && !styleBlock.includes('.dshtu-'))
  // 只在 require('react') 之外不引入别的依赖
  const requires = [...css.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1])
  expect('只 require react', requires.length > 0 && requires.every((name) => name === 'react'), requires)
}

// ---------- 用例 6：Host 解析器与路径闸门 ----------
group('Host 解析器')
let internals
{
  const host = await import(HOST.href)
  internals = host.__internals
  expect('Host 半导出了可测内部函数', typeof internals?.parseStatusZ === 'function', typeof internals)

  const parsed = internals.parseStatusZ('M  a.txt\0 M b.txt\0?? c.txt\0R  new.txt\0old.txt\0')
  expect('porcelain -z 解析出 4 条', parsed.length === 4, parsed.length)
  expect('暂存 M 被识别', parsed[0].x === 'M' && parsed[0].path === 'a.txt', parsed[0])
  expect('工作区 M 被识别', parsed[1].y === 'M' && parsed[1].path === 'b.txt', parsed[1])
  expect('未跟踪被识别', parsed[2].x === '?' && parsed[2].kind === undefined, parsed[2])
  expect('重命名带上原路径', parsed[3].from === 'old.txt' && parsed[3].path === 'new.txt', parsed[3])
  expect('中文路径不被转义', internals.parseStatusZ('?? 中文 文件.txt\0')[0].path === '中文 文件.txt')

  const logRaw = 'h1\x1fh1\x1fAnn\x1fa@b.c\x1f2024-01-01T00:00:00+08:00\x1fHEAD -> main, origin/main\x1fFix | pipe\x1fbody\x1e'
  const commits = internals.parseLog(logRaw)
  expect('log 解析出 1 条', commits.length === 1, commits.length)
  expect('标题里的竖线不影响解析', commits[0].subject === 'Fix | pipe', commits[0].subject)
  expect('refs 被拆开', JSON.stringify(commits[0].refs) === JSON.stringify(['HEAD -> main', 'origin/main']), commits[0].refs)
  expect('空 log 返回空数组', internals.parseLog('').length === 0)

  expect('分类：未跟踪', internals.classify('?', '?') === 'untracked')
  expect('分类：冲突', internals.classify('U', 'U') === 'conflicted')
  expect('分类：重命名', internals.classify('R', ' ') === 'renamed')
  expect('isStaged 判定正确', internals.isStaged({ x: 'M' }) === true && internals.isStaged({ x: ' ' }) === false && internals.isStaged({ x: '?' }) === false)

  expect('路径闸门拒绝相对路径', internals.resolveRepo('relative/path', []) === null)
  expect('路径闸门拒绝不存在的路径', internals.resolveRepo(join(tmpdir(), 'definitely-missing-dsh-git'), []) === null)
  expect('路径闸门接受真实目录', typeof internals.resolveRepo(tmpdir(), []) === 'string')
  const roots = [internals.resolveRepo(tmpdir(), [])]
  expect('受限时拒绝根目录之外', internals.resolveRepo(process.cwd(), roots) === null || process.cwd().startsWith(tmpdir()))
}

// ---------- 用例 7：对真实临时仓库跑一遍（含写操作） ----------
group('真实仓库端到端')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-smoke-'))
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  try {
    run(['init'])
    run(['config', 'user.email', 'smoke@example.com'])
    run(['config', 'user.name', 'Smoke Test'])
    run(['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', '中文.txt'), 'hello\n')

    let status = await internals.buildStatus(dir)
    expect('新仓库有未跟踪文件', status.files.length === 2, status.files.map((file) => file.path))
    expect('未跟踪被判为 unstaged', status.unstaged.length === 2, status.unstaged.length)
    expect('中文文件名原样返回', status.files.some((file) => file.path === 'sub/中文.txt'), status.files.map((file) => file.path))

    // 全部暂存并提交
    await internals.runAction(dir, 'stage-all', {})
    status = await internals.buildStatus(dir)
    expect('全部暂存后 staged=2', status.staged.length === 2, status.staged.length)
    expect('全部暂存后 unstaged=0', status.unstaged.length === 0, status.unstaged.length)

    const commit = await internals.runAction(dir, 'commit', { message: '初始提交' })
    expect('提交成功', commit.ok === true, commit.stderr)
    status = await internals.buildStatus(dir)
    expect('提交后工作区干净', status.clean === true, status.files)
    expect('分支名读到了', typeof status.branch === 'string' && status.branch !== '', status.branch)

    // 改一行 → 差异里有增删
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    status = await internals.buildStatus(dir)
    expect('改动被检出', status.unstaged.length === 1, status.unstaged.length)
    const diff = await internals.buildDiff(dir, 'a.txt', {})
    expect('差异非空', diff.diff.length > 0, diff.diff.slice(0, 80))
    expect('差异含新增行', diff.diff.includes('+TWO'), diff.diff.slice(0, 200))

    // 未跟踪文件的差异：靠 --no-index 兜底
    writeFileSync(join(dir, 'brand-new.txt'), 'brand\n')
    const newDiff = await internals.buildDiff(dir, 'brand-new.txt', {})
    expect('未跟踪文件也能出差异', newDiff.diff.includes('brand'), newDiff.diff.slice(0, 200))

    // 暂存后 staged 差异可见
    await internals.runAction(dir, 'stage', { files: ['a.txt'] })
    const stagedDiff = await internals.buildDiff(dir, 'a.txt', { staged: true })
    expect('暂存差异非空', stagedDiff.diff.length > 0, stagedDiff.diff.slice(0, 80))
    await internals.runAction(dir, 'unstage', { files: ['a.txt'] })
    status = await internals.buildStatus(dir)
    expect('取消暂存后回到 unstaged', status.unstaged.some((file) => file.path === 'a.txt'), status.unstaged.map((file) => file.path))

    // 历史
    const log = await internals.buildLog(dir, {})
    expect('历史里有 1 条提交', log.commits.length === 1, log.commits.length)
    expect('提交标题正确（含中文）', log.commits[0].subject === '初始提交', log.commits[0].subject)
    const detail = await internals.buildCommit(dir, log.commits[0].hash)
    expect('提交详情能读到', detail !== null && detail.files.length === 2, detail?.files)

    // 分支
    await internals.runAction(dir, 'create-branch', { name: 'feature/smoke' })
    const branches = await internals.buildBranches(dir)
    expect('新分支出现在本地列表', branches.locals.some((branch) => branch.name === 'feature/smoke'), branches.locals.map((branch) => branch.name))
    expect('当前分支标记正确', branches.locals.some((branch) => branch.current === true), branches.locals.map((branch) => [branch.name, branch.current]))

    // 放弃修改
    await internals.runAction(dir, 'discard', { files: ['a.txt'] })
    const afterDiscard = await internals.buildDiff(dir, 'a.txt', {})
    expect('放弃修改后差异为空', afterDiscard.diff.trim() === '', afterDiscard.diff.slice(0, 120))

    // 非法动作不崩
    const bogus = await internals.runAction(dir, 'not-an-action', {})
    expect('未知动作返回失败而不是抛错', bogus.ok === false, bogus)
    // 空提交信息被拒
    const emptyMessage = await internals.runAction(dir, 'commit', { message: '   ' })
    expect('空提交信息被拒', emptyMessage.ok === false, emptyMessage)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- 用例 7b：丢弃 / 删除的语义 ----------
// 这一段是回归用例：未跟踪文件的「丢弃」在 git 里只能是删除。
// 早先一律用 `checkout -- <file>`，对未跟踪文件必然以
// `error: pathspec ... did not match any file(s) known to git` 失败，
// 于是单个丢弃和「全部丢弃」都报错。
group('丢弃与删除语义')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-discard-'))
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  const exists = (name) => existsSync(join(dir, name))
  // 读出来的文本统一把 CRLF 折成 LF 再比对：Windows 上 git 默认 autocrlf，
  // 还原回来的行尾是 CRLF，这是 git 的正常行为，不是被丢弃的内容出错。
  const text = (name) => readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n')
  try {
    run(['init'])
    run(['config', 'user.email', 'smoke@example.com'])
    run(['config', 'user.name', 'Smoke Test'])
    run(['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    run(['add', '-A'])
    run(['commit', '-m', 'base'])

    // --- 单个丢弃：未跟踪 = 删除 ---
    writeFileSync(join(dir, 'brand-new.txt'), 'brand\n')
    writeFileSync(join(dir, 'a.txt'), 'one\nCHANGED\n')
    const single = await internals.runAction(dir, 'discard', { files: ['brand-new.txt'] })
    expect('丢弃未跟踪文件不报错', single.ok === true, single.stderr)
    expect('未跟踪文件被删除', exists('brand-new.txt') === false)
    expect('只动点名的文件', exists('a.txt') === true)

    // --- 单个丢弃：已跟踪 = 还原内容（不是删除）---
    const tracked = await internals.runAction(dir, 'discard', { files: ['a.txt'] })
    expect('丢弃已跟踪文件不报错', tracked.ok === true, tracked.stderr)
    expect('已跟踪文件被还原而不是删除', exists('a.txt') === true && text('a.txt') === 'one\n', text('a.txt'))

    // --- 一次同时丢弃「已跟踪 + 未跟踪」：两条路径都要走到 ---
    writeFileSync(join(dir, 'a.txt'), 'one\nCHANGED\n')
    writeFileSync(join(dir, 'mixed-new.txt'), 'new\n')
    const mixed = await internals.runAction(dir, 'discard', { files: ['a.txt', 'mixed-new.txt'] })
    expect('混合丢弃不报错', mixed.ok === true, mixed.stderr)
    expect('混合丢弃：已跟踪被还原', text('a.txt') === 'one\n')
    expect('混合丢弃：未跟踪被删除', exists('mixed-new.txt') === false)

    // --- 全部丢弃 ---
    writeFileSync(join(dir, 'a.txt'), 'one\nCHANGED\n')
    writeFileSync(join(dir, 'brand-new.txt'), 'brand\n')
    writeFileSync(join(dir, 'ignored.txt'), 'build output\n')
    mkdirSync(join(dir, 'newdir'), { recursive: true })
    writeFileSync(join(dir, 'newdir', 'deep.txt'), 'deep\n')
    // 新增并已暂存的文件属于「本周期新加的东西」，全部丢弃时也该消失。
    writeFileSync(join(dir, 'staged-new.txt'), 'staged\n')
    run(['add', 'staged-new.txt'])

    const all = await internals.runAction(dir, 'discard-all', {})
    expect('全部丢弃不报错', all.ok === true, all.stderr)
    const afterAll = await internals.buildStatus(dir)
    expect('全部丢弃后工作区干净', afterAll.clean === true, afterAll.files)
    expect('全部丢弃：已跟踪还原', text('a.txt') === 'one\n')
    expect('全部丢弃：未跟踪删除', exists('brand-new.txt') === false)
    expect('全部丢弃：新增未跟踪目录也删掉', exists('newdir') === false)
    expect('全部丢弃：已暂存的新文件也删掉', exists('staged-new.txt') === false)
    // 被 .gitignore 忽略的文件是构建产物，误删代价最大，必须保留。
    expect('全部丢弃保留被忽略的文件', exists('ignored.txt') === true)

    // --- 顺序回归：`checkout --` 取的是**索引**而不是 HEAD ---
    // 若把它放在 `reset HEAD` 之前，它会把「已暂存的修改」写回工作区，
    // 之后 reset 再重置索引，那些内容就永久留在了工作区 —— 表现为
    // 「暂存过的改动丢不掉」。这条用例专门钉住这个顺序。
    writeFileSync(join(dir, 'a.txt'), 'one\nSTAGED-EDIT\n')
    run(['add', 'a.txt'])
    writeFileSync(join(dir, 'a.txt'), 'one\nWORKTREE-EDIT\n')
    const ordered = await internals.runAction(dir, 'discard-all', {})
    expect('已暂存后又改过的文件也能丢弃', ordered.ok === true, ordered.stderr)
    expect('丢弃后回到上次提交的内容', text('a.txt') === 'one\n', text('a.txt'))
    const afterOrder = await internals.buildStatus(dir)
    expect('丢弃后索引也干净（无残留暂存）', afterOrder.clean === true, afterOrder.files)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- 用例 7c：贮藏的应用 / 恢复 / 删除 ----------
// 这一段钉住两件事：
//   ① 应用贮藏**保留**该条（stash apply），恢复才删除（stash pop）—— 两者别搞混；
//   ② 操作对象由调用方显式指定，不再隐式对 stash@{0} 动手。
group('贮藏：应用保留、恢复删除、显式选条')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-stash-'))
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  const text = (name) => readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n')
  try {
    run(['init'])
    run(['config', 'user.email', 'smoke@example.com'])
    run(['config', 'user.name', 'Smoke Test'])
    run(['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(dir, 'a.txt'), 'base\n')
    run(['add', '-A'])
    run(['commit', '-m', 'base'])

    // 造两条内容不同的贮藏：stash@{0} 是后存的（second），stash@{1} 是先存的（first）。
    writeFileSync(join(dir, 'a.txt'), 'first\n')
    const first = await internals.runAction(dir, 'stash-save', { message: '第一条' })
    expect('贮藏第一条成功', first.ok === true, first.stderr)
    writeFileSync(join(dir, 'a.txt'), 'second\n')
    const second = await internals.runAction(dir, 'stash-save', { message: '第二条' })
    expect('贮藏第二条成功', second.ok === true, second.stderr)

    let status = await internals.buildStatus(dir)
    expect('贮藏列表读到 2 条', status.stashes.length === 2, status.stashes)
    expect('贮藏按新到旧排列', status.stashes[0].ref === 'stash@{0}' && status.stashes[1].ref === 'stash@{1}', status.stashes.map((item) => item.ref))
    expect('贮藏说明文字被读到', status.stashes[0].message.includes('第二条'), status.stashes[0].message)

    // --- 应用指定的那条（不是最新那条），并且要保留 ---
    const applied = await internals.runAction(dir, 'stash-apply', { name: 'stash@{1}' })
    expect('应用指定贮藏不报错', applied.ok === true, applied.stderr)
    expect('应用的是选中的那条内容', text('a.txt') === 'first\n', text('a.txt'))
    status = await internals.buildStatus(dir)
    expect('应用后贮藏**不**被删除', status.stashes.length === 2, status.stashes.map((item) => item.ref))
    expect('应用后工作区带上了改动', status.files.some((file) => file.path === 'a.txt'), status.files)

    // 把工作区清干净，好验证下一条
    await internals.runAction(dir, 'discard-all', {})

    // --- 应用是幂等的可重复操作 ---
    const reapplied = await internals.runAction(dir, 'stash-apply', { name: 'stash@{1}' })
    expect('应用可重复执行', reapplied.ok === true, reapplied.stderr)
    await internals.runAction(dir, 'discard-all', {})

    // --- 恢复指定那条：删掉它，其余保留 ---
    const popped = await internals.runAction(dir, 'stash-pop', { name: 'stash@{1}' })
    expect('恢复指定贮藏不报错', popped.ok === true, popped.stderr)
    expect('恢复的是选中的那条内容', text('a.txt') === 'first\n', text('a.txt'))
    status = await internals.buildStatus(dir)
    expect('恢复后只剩 1 条', status.stashes.length === 1, status.stashes.map((item) => item.ref))
    expect('剩下的是没动的那条', status.stashes[0].message.includes('第二条'), status.stashes[0].message)

    // --- 不带 ref 一律拒绝：避免隐式对最新一条动手 ---
    const noRefApply = await internals.runAction(dir, 'stash-apply', {})
    expect('应用不给 ref 被拒', noRefApply.ok === false, noRefApply)
    const noRefPop = await internals.runAction(dir, 'stash-pop', {})
    expect('恢复不给 ref 被拒', noRefPop.ok === false, noRefPop)
    status = await internals.buildStatus(dir)
    expect('被拒的操作没有动到贮藏', status.stashes.length === 1, status.stashes.map((item) => item.ref))

    // --- 删除指定那条 ---
    const dropped = await internals.runAction(dir, 'stash-drop', { name: 'stash@{0}' })
    expect('删除指定贮藏成功', dropped.ok === true, dropped.stderr)
    status = await internals.buildStatus(dir)
    expect('删除后贮藏清空', status.stashes.length === 0, status.stashes)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- 用例 8：从指定起点建分支 + 合并 ----------
group('起点分支与合并')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-merge-'))
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  const tryRun = (args) => {
    try {
      return run(args)
    } catch {
      return ''
    }
  }
  try {
    run(['init', '-q'])
    run(['config', 'user.email', 'smoke@example.com'])
    run(['config', 'user.name', 'Smoke Test'])
    run(['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(dir, 'f.txt'), 'base\n')
    run(['add', '-A'])
    run(['commit', '-qm', 'base'])
    const baseBranch = tryRun(['rev-parse', '--abbrev-ref', 'HEAD'])

    // 造一个裸远程，用真实的 origin/<branch> 测「从远端分支建」
    const origin = mkdtempSync(join(tmpdir(), 'dsh-git-origin-'))
    execFileSync('git', ['init', '--bare', '-q'], { cwd: origin })
    run(['remote', 'add', 'origin', origin])
    run(['push', '-q', '-u', 'origin', 'HEAD'])

    // (1) 从本地分支建
    run(['branch', 'develop'])
    let result = await internals.runAction(dir, 'create-branch', { name: 'feat/from-local', startPoint: 'develop' })
    expect('从本地分支建分支成功', result.ok === true, result.stderr)
    expect('建完切到了新分支', tryRun(['rev-parse', '--abbrev-ref', 'HEAD']) === 'feat/from-local')
    run(['checkout', '-q', baseBranch])

    // (2) 从远程分支建：起点是 origin/<base>，且不该顺手绑定上游
    result = await internals.runAction(dir, 'create-branch', { name: 'feat/from-remote', startPoint: `origin/${baseBranch}` })
    expect('从远程分支建分支成功', result.ok === true, result.stderr)
    expect('起点取的是远程分支的提交', tryRun(['rev-parse', 'HEAD']) === tryRun(['rev-parse', `origin/${baseBranch}`]))
    expect('不隐式绑定上游（--no-track）', tryRun(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) === '', tryRun(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']))
    run(['checkout', '-q', baseBranch])

    // (3) 不给起点 = 从当前 HEAD 建（保持原有行为）
    result = await internals.runAction(dir, 'create-branch', { name: 'feat/no-point' })
    expect('不给起点时从 HEAD 建', result.ok === true && tryRun(['rev-parse', '--abbrev-ref', 'HEAD']) === 'feat/no-point', result.stderr)
    run(['checkout', '-q', baseBranch])

    // (4) 分叉出一条线，测快进合并
    run(['checkout', '-q', '-b', 'topic', baseBranch])
    writeFileSync(join(dir, 'topic.txt'), 'topic\n')
    run(['add', '-A'])
    run(['commit', '-qm', 'topic work'])
    run(['checkout', '-q', baseBranch])
    result = await internals.runAction(dir, 'merge', { name: 'topic', ffOnly: true })
    expect('快进合并成功', result.ok === true, result.stderr)
    expect('快进后是线性历史（无合并提交）', tryRun(['log', '--merges', '--oneline', '-1']) === '', tryRun(['log', '--merges', '--oneline', '-1']))

    // (5) 再分叉一条，测强制合并提交
    run(['checkout', '-q', '-b', 'topic2', baseBranch])
    writeFileSync(join(dir, 'topic2.txt'), 'topic2\n')
    run(['add', '-A'])
    run(['commit', '-qm', 'topic2 work'])
    run(['checkout', '-q', baseBranch])
    result = await internals.runAction(dir, 'merge', { name: 'topic2' })
    expect('强制合并提交成功', result.ok === true, result.stderr)
    expect('产生了合并提交', tryRun(['log', '--merges', '--oneline', '-1']) !== '', tryRun(['log', '--oneline', '-3']))

    // (6) 冲突：合并失败 + merging 标志 + 冲突分类 + 放弃合并
    const before = await internals.buildStatus(dir)
    expect('未合并时 merging 为 false', before.merging === false, before.merging)

    run(['checkout', '-q', '-b', 'conflict-side', baseBranch])
    writeFileSync(join(dir, 'f.txt'), 'side version\n')
    run(['commit', '-qam', 'side change'])
    run(['checkout', '-q', baseBranch])
    writeFileSync(join(dir, 'f.txt'), 'base version\n')
    run(['commit', '-qam', 'base change'])

    result = await internals.runAction(dir, 'merge', { name: 'conflict-side' })
    expect('有冲突时合并失败（不假装成功）', result.ok === false, result.ok)
    const during = await internals.buildStatus(dir)
    expect('冲突期间 merging 为 true', during.merging === true, during.merging)
    expect('冲突文件被标记为 conflicted', during.files.some((file) => file.kind === 'conflicted'), during.files.map((file) => [file.path, file.kind]))

    const aborted = await internals.runAction(dir, 'merge-abort', {})
    expect('放弃合并成功', aborted.ok === true, aborted.stderr)
    const after = await internals.buildStatus(dir)
    expect('放弃后 merging 回到 false', after.merging === false, after.merging)
    expect('放弃后工作区干净', after.clean === true, after.files)

    // (7) 非法输入
    const emptyName = await internals.runAction(dir, 'merge', { name: '' })
    expect('空分支名合并不执行', emptyName.ok === false, emptyName)
    const emptyCreate = await internals.runAction(dir, 'create-branch', { name: '' })
    expect('空分支名建分支不执行', emptyCreate.ok === false, emptyCreate)

    rmSync(origin, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
