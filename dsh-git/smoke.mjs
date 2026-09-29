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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  useEffect(fn) {
    const index = hookIndex++
    const slot = hooks
    if (slot.length <= index) {
      slot[index] = true
      // 副作用返回的清理函数在静态渲染里没有意义，但要防止它被当成新 hook 值。
      const result = fn()
      if (typeof result === 'function') slot[index] = result
    }
  },
  useMemo(fn) {
    const index = hookIndex++
    const slot = hooks
    if (slot.length <= index) slot[index] = fn()
    return slot[index]
  },
  useCallback(fn) {
    const index = hookIndex++
    const slot = hooks
    if (slot.length <= index) slot[index] = fn
    return slot[index]
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
  const attrs = []
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || value === undefined || value === null) continue
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
  const body = render(children)
  return `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${body}</${type}>`
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
    const html = render(React.createElement(component, nextProps ?? props))
    rootHooks = hooks
    return html
  }
  const html = rerender(props)
  return { html, rerender }
}

// ---------- 装载 client.js ----------
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
  const context = vm.createContext({
    window: sandboxWindow,
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
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), context, { filename: 'client.js' })
  if (captured === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  const moduleFace = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require("${name}")`)
  })
  return { definition: captured, moduleFace }
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
{
  const loaded = loadPlugin()
  moduleFace = loaded.moduleFace
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

  // (c) 标题槽位：渲染出名字，且不依赖任何 props.view。
  let titleHtml = ''
  try {
    titleHtml = mount(title.component, { t: (key) => key }).html
  } catch (error) {
    expect('标题渲染不报错', false, error.message)
  }
  expect('标题渲染出文案', titleHtml.includes('tabTitle'), titleHtml)
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

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
