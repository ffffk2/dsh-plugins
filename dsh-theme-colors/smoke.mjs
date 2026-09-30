/**
 * dsh-theme-colors Client 半的本地冒烟测试。
 *
 * 在 Node 里用一个极简 React（createElement + hooks + 静态渲染）跑一遍
 * client.js 的注册契约、状态清洗、深/浅两侧的 token 覆盖写入、设置页渲染、
 * 模式跟随与预设配色体检（WCAG 对比度 + 底色亮度），
 * 用来在重启 DSH 之前把接口用法错误挑出来。
 */
import fs from 'node:fs'
import vm from 'node:vm'

const CLIENT = new URL('./client.js', import.meta.url)

// ---------- 极简 React ----------
let hooks = null
let hookIndex = 0
let handlers = []

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
  useState(initial) {
    const index = hookIndex++
    if (hooks.length <= index) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
  },
  useReducer(reducer, initial) {
    const index = hookIndex++
    if (hooks.length <= index) hooks[index] = initial
    return [hooks[index], (action) => { hooks[index] = reducer(hooks[index], action) }]
  },
  useEffect(fn) {
    const index = hookIndex++
    if (hooks.length <= index) {
      hooks[index] = true
      fn()
    }
  },
  useMemo(fn) {
    const index = hookIndex++
    if (hooks.length <= index) hooks[index] = fn()
    return hooks[index]
  },
  useCallback(fn) {
    const index = hookIndex++
    if (hooks.length <= index) hooks[index] = fn
    return hooks[index]
  },
  useRef(value) {
    const index = hookIndex++
    if (hooks.length <= index) hooks[index] = { current: value }
    return hooks[index]
  },
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(String(node))
  if (Array.isArray(node)) return node.map(render).join('')
  const { type, props, children } = node
  if (typeof type === 'function') {
    const savedHooks = hooks
    const savedIndex = hookIndex
    hooks = []
    hookIndex = 0
    const out = type({ ...props, children: children.length > 0 ? children : undefined })
    hooks = savedHooks
    hookIndex = savedIndex
    return render(out)
  }
  const attrs = []
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || value === undefined || value === null) continue
    if (name === 'onChange' || name === 'onClick' || name === 'onBlur') {
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
    attrs.push(`${name}="${escapeHtml(String(value))}"`)
  }
  const body = type === 'input' ? '' : render(children)
  return `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${body}${type === 'input' ? '' : `</${type}>`}`
}

// ---------- 装载 client.js ----------
function loadPlugin(stored) {
  let captured = null
  const storage = new Map()
  if (stored !== undefined) storage.set('dsh-theme-colors/v1', stored)
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  }
  const sandboxWindow = {
    localStorage,
    __ModuleLoader__: { load: (definition) => { captured = definition } },
  }
  const context = vm.createContext({ window: sandboxWindow, console, React, require: undefined })
  context.globalThis = context
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), context, { filename: 'client.js' })
  if (captured === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  const moduleFace = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require("${name}")`)
  })
  return { definition: captured, moduleFace, storage }
}

function makeContext(colorScheme) {
  const state = { overrides: [], registered: null, dictionaries: null, listeners: [], scheme: colorScheme ?? 'dark' }
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dict) => { state.dictionaries = { ns, dict }; return () => {} },
    },
    slots: {
      inject: (name, callback) => { state.injectName = name; callback() },
      register: (options, component) => { state.registered = { options, component }; return () => {} },
    },
    theme: {
      overrideTokens: (source, tokens) => { state.overrides.push({ source, tokens }); return () => {} },
      // 官方快照形状：{ preference, fontSize, active: { colorScheme }, … }。
      // 覆盖层按 active.colorScheme 选一侧（ui-theme 的 composeActive 就一句 modes[active.colorScheme]）。
      getTheme: () => ({ active: { colorScheme: state.scheme } }),
    },
    on: (name, handler) => {
      const entry = { name, handler }
      state.listeners.push(entry)
      return () => { state.listeners = state.listeners.filter((item) => item !== entry) }
    },
    effect: (fn) => fn(),
  }
  return { ctx, state }
}

/** 模拟主题服务广播：换配色方案后触发 theme/change。 */
function switchScheme(state, scheme) {
  state.scheme = scheme
  for (const entry of [...state.listeners]) {
    if (entry.name === 'theme/change') entry.handler()
  }
}

function check(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`) ; return true }
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  return false
}

let failures = 0
function group(title) { console.log(`\n== ${title} ==`) }
function expect(label, condition, detail) { if (!check(label, condition, detail)) failures += 1 }

// ---------- 用例 1：注册契约 ----------
group('注册契约')
{
  const { definition, moduleFace, storage } = loadPlugin()
  expect('module id 与包名一致', definition.id === '@local/dsh-theme-colors', definition.id)
  expect('inject 含 slots/locale/theme', JSON.stringify(moduleFace.inject) === JSON.stringify(['slots', 'locale', 'theme']), moduleFace.inject)
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  expect('locale 字典已注册', state.dictionaries?.ns === 'theme-colors')
  // 文案护栏：zh/en 必须成对齐的一套，漏一个键在界面上就是裸 key
  const dict = state.dictionaries?.dict ?? {}
  const zhKeys = Object.keys(dict.zh ?? {})
  const enKeys = Object.keys(dict.en ?? {})
  expect('字典同时注册了 zh/en', zhKeys.length > 0 && enKeys.length > 0, [zhKeys.length, enKeys.length])
  expect('zh/en 键完全对齐', zhKeys.length === enKeys.length && zhKeys.every((key) => key in dict.en), { zh: zhKeys.length, en: enKeys.length })
  expect('字典覆盖两套配色的文案', zhKeys.includes('modeDark') && zhKeys.includes('modeLight') && zhKeys.includes('modeHint'))
  expect('文案全部非空', [...Object.values(dict.zh), ...Object.values(dict.en)].every((value) => typeof value === 'string' && value.length > 0))
  expect('slot 名是 settings.section', state.injectName === 'settings.section', state.injectName)
  expect('section id 是 theme-colors', state.registered?.options?.id === 'theme-colors', state.registered?.options)
  expect('section 有 label 函数', typeof state.registered?.options?.label === 'function')
  expect('组件是函数', typeof state.registered?.component === 'function')
  expect('默认无改动 → 不注册覆盖层', state.overrides.length === 0, state.overrides)
  // 渲染
  handlers = []
  hooks = []
  hookIndex = 0
  let html = ''
  try {
    html = render(React.createElement(state.registered.component, {}))
  } catch (error) {
    expect('设置页渲染不报错', false, error.message)
  }
  expect('设置页渲染出根节点', html.includes('dshtc-root'))
  expect('渲染出 1 个预设卡片 + 4 个颜色分组', (html.match(/dshtc-card"/g) || []).length === 5, (html.match(/dshtc-card"/g) || []).length)
  expect('渲染出 11 行颜色', (html.match(/dshtc-row"/g) || []).length === 11, (html.match(/dshtc-row"/g) || []).length)
  expect('取色器与文本输入都在', (html.match(/type="color"/g) || []).length === 11 && (html.match(/type="text"/g) || []).length === 11, [ (html.match(/type="color"/g) || []).length, (html.match(/type="text"/g) || []).length ])
  expect('未改动时不显示重置按钮', !html.includes('>reset<'))
  // 模式 tab：默认编辑「当前正在生效」的那一套（这里主题服务报告的是 dark）
  const tabsHtml = (html.match(/className="dshtc-mode[ "]/g) || []).length
  expect('渲染出 2 个模式 tab', tabsHtml === 2, tabsHtml)
  const onTab = handlers.find(
    (entry) => entry.event === 'onClick' && String(entry.attrs.className ?? '').includes('dshtc-mode is-on'),
  )
  expect('默认编辑深色（跟随当前配色）', textOf(onTab?.attrs.children?.[0]) === 'modeDark', textOf(onTab?.attrs.children?.[0]))
  expect('已监听 theme/change', state.listeners.some((entry) => entry.name === 'theme/change'))
  console.log(`  存储未写入（未改动）：${storage.size === 0}`)
}

// ---------- 用例 2：预置配色 → 覆盖层内容 ----------
group('预置配色应用')
{
  const stored = JSON.stringify({
    enabled: true,
    dark: {
      '--dsw-alias-bg-base': '#000000',
      '--dsw-alias-brand-primary': 'rgb(255, 106, 0)',
      '--dsw-alias-border-l1': '#ffffff33',
    },
  })
  const { moduleFace } = loadPlugin(stored)
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  expect('注册了一次覆盖层', state.overrides.length === 1, state.overrides.length)
  const tokens = state.overrides[0]?.tokens ?? {}
  expect('来源标识正确', state.overrides[0]?.source === 'dsh-theme-colors', state.overrides[0]?.source)
  expect('三项都进覆盖层', Object.keys(tokens).length === 3, Object.keys(tokens))
  expect('主背景 dark 生效', tokens['--dsw-alias-bg-base']?.dark === '#000000', tokens['--dsw-alias-bg-base'])
  expect('主背景 light 仍是官方值', tokens['--dsw-alias-bg-base']?.light === '#ffffff', tokens['--dsw-alias-bg-base'])
  expect('每项都是 {light,dark} 字符串对', Object.values(tokens).every((pair) => typeof pair.light === 'string' && typeof pair.dark === 'string'))
  expect('链接蓝未被误加', tokens['--dsw-alias-state-business-primary'] === undefined)
}

// ---------- 用例 3：脏数据会被清洗 ----------
group('脏数据清洗')
{
  const stored = JSON.stringify({
    enabled: true,
    dark: {
      '--dsw-alias-bg-base': '#123456',
      '--not-a-token': '#ffffff',
      '--dsw-alias-bg-layer-1': 'javascript:alert(1)',
      '--dsw-alias-label-primary': 42,
    },
  })
  const { moduleFace } = loadPlugin(stored)
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  const tokens = state.overrides[0]?.tokens ?? {}
  expect('只保留合法的一项', Object.keys(tokens).length === 1, Object.keys(tokens))
  expect('保留的是合法 token', tokens['--dsw-alias-bg-base']?.dark === '#123456')
}

// ---------- 用例 4：enabled:false 全部不生效 ----------
group('总开关')
{
  const stored = JSON.stringify({ enabled: false, dark: { '--dsw-alias-bg-base': '#000000' } })
  const { moduleFace } = loadPlugin(stored)
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  expect('关掉后不注册覆盖层', state.overrides.length === 0, state.overrides)
}

// ---------- 用例 5：与默认值相同的项不进覆盖层 ----------
group('等于默认值时不覆盖')
{
  const stored = JSON.stringify({ enabled: true, dark: { '--dsw-alias-bg-base': '#151517' } })
  const { moduleFace } = loadPlugin(stored)
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  expect('默认值被跳过', state.overrides.length === 0, state.overrides)
}

// ---------- 用例 6：改色写入路径（onChange → 覆盖层 + 持久化） ----------
group('改色写入路径')
{
  const { moduleFace, storage } = loadPlugin(JSON.stringify({ enabled: true, dark: {} }))
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)

  handlers = []
  hooks = []
  hookIndex = 0
  render(React.createElement(state.registered.component, {}))
  const pickers = handlers.filter((entry) => entry.event === 'onChange' && entry.attrs.type === 'color')
  expect('拿到 11 个取色器 onChange', pickers.length === 11, pickers.length)
  expect('第一个取色器是主背景', (pickers[0]?.attrs['aria-label'] || '').includes('--dsw-alias-bg-base'), pickers[0]?.attrs['aria-label'])

  pickers[0].handler({ target: { value: '#0b1020' } })
  expect('产生了一次覆盖调用', state.overrides.length === 1, state.overrides.length)
  expect('主背景写入 #0b1020', state.overrides[0]?.tokens?.['--dsw-alias-bg-base']?.dark === '#0b1020', state.overrides[0]?.tokens)
  const saved = JSON.parse(storage.get('dsh-theme-colors/v1'))
  expect('已持久化到 localStorage', saved.dark['--dsw-alias-bg-base'] === '#0b1020', saved)

  // 重新渲染：应显示新值，并出现重置按钮
  handlers = []
  hooks = []
  hookIndex = 0
  const html = render(React.createElement(state.registered.component, {}))
  expect('重渲染后输入框是新值', html.includes('value="#0b1020"'), html.slice(0, 0))
  expect('出现重置按钮', html.includes('>reset<'))
  expect('徽标显示已改 1 项', html.includes('1 changed'), html.match(/dshtc-badge[^>]*>([^<]*)</)?.[1])

  // 文本输入同样接受 rgb() 与 8 位十六进制
  const texts = handlers.filter((entry) => entry.event === 'onChange' && entry.attrs.type === 'text')
  expect('拿到 11 个文本输入 onChange', texts.length === 11, texts.length)
  const borders = texts.find((entry) => (entry.attrs['aria-label'] || '').includes('--dsw-alias-border-l1'))
  borders.handler({ target: { value: '#ff000080' } })
  const last = state.overrides[state.overrides.length - 1]
  expect('8 位十六进制被接受', last?.tokens?.['--dsw-alias-border-l1']?.dark === '#ff000080', last?.tokens)

  // 非法值被拒绝：不产生新的覆盖调用
  const before = state.overrides.length
  texts[0].handler({ target: { value: 'not-a-color' } })
  expect('非法颜色被拒绝', state.overrides.length === before, state.overrides.length - before)
}

// ---------- 用例 7：预设配色 ----------
group('预设配色')

/** 收集元素文本（递归子节点里的字符串）。 */
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node !== null && typeof node === 'object') return textOf(node.children)
  return ''
}

function luminance(hex) {
  const clean = String(hex).replace('#', '').slice(0, 6)
  const channels = [0, 2, 4].map((i) => Number.parseInt(clean.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

{
  // 故意先关掉总开关：预设应该能在关闭状态下点，并自动重新启用。
  const { moduleFace, storage } = loadPlugin(JSON.stringify({ enabled: false, dark: {} }))
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)

  handlers = []
  hooks = []
  hookIndex = 0
  render(React.createElement(state.registered.component, {}))
  const cards = handlers.filter(
    (entry) => entry.event === 'onClick' && String(entry.attrs.className ?? '').startsWith('dshtc-preset'),
  )
  expect('渲染出 7 套预设', cards.length === 7, cards.length)
  expect('总开关关闭时预设仍可点', state.overrides.length === 0)

  const rows = []
  let contrastFailures = 0
  let incomplete = 0

  for (const card of cards) {
    const name = textOf(card.attrs.children?.[0]) || '(未命名)'
    card.handler({})
    const payload = state.overrides[state.overrides.length - 1]?.tokens ?? {}
    const dark = {}
    for (const [token, pair] of Object.entries(payload)) dark[token] = pair.dark
    if (Object.keys(dark).length !== 11) incomplete += 1
    const bg = dark['--dsw-alias-bg-base']
    const checks = [
      contrast(dark['--dsw-alias-label-primary'], bg) >= 7,
      contrast(dark['--dsw-alias-label-primary'], bg) <= 13,
      contrast(dark['--dsw-alias-label-secondary'], bg) >= 4.5,
      contrast(dark['--dsw-alias-state-business-primary'], bg) >= 4.5,
      contrast(dark['--dsw-alias-state-business-primary'], bg) <= 9,
      contrast(dark['--dsw-alias-label-primary'], dark['--dsw-alias-bg-layer-2']) >= 5,
      contrast(dark['--dsw-alias-brand-primary'], '#292929') >= 4.5,
    ]
    if (checks.some((ok) => !ok)) contrastFailures += 1
    rows.push({
      name,
      bg,
      正文: contrast(dark['--dsw-alias-label-primary'], bg).toFixed(2),
      链接: contrast(dark['--dsw-alias-state-business-primary'], bg).toFixed(2),
      tokens: Object.keys(dark).length,
    })
  }

  expect('每套都覆盖 11 个 token（点一下就是完整一套）', incomplete === 0, incomplete)
  expect('每套的对比度都在护眼区间内', contrastFailures === 0, contrastFailures)
  expect('7 套底色互不相同', new Set(rows.map((row) => row.bg)).size === 7, rows.map((row) => row.bg))
  expect('持久化的是整份预设', Object.keys(JSON.parse(storage.get('dsh-theme-colors/v1')).dark).length === 11)
  console.log('  预设概览：')
  for (const row of rows) console.log(`    ${row.name.padEnd(18)} 底 ${row.bg}  正文/底 ${row.正文}  链接/底 ${row.链接}`)

  // 点完之后：总开关自动打开、该卡片高亮
  handlers = []
  hooks = []
  hookIndex = 0
  const html = render(React.createElement(state.registered.component, {}))
  const onCount = (html.match(/dshtc-preset is-on/g) || []).length
  expect('恰好一套预设处于高亮', onCount === 1, onCount)
  expect('总开关被自动打开', JSON.parse(storage.get('dsh-theme-colors/v1')).enabled === true)
  const lastApplied = textOf(cards[cards.length - 1].attrs.children?.[0])
  const onCard = handlers.find(
    (entry) =>
      entry.event === 'onClick' &&
      String(entry.attrs.className ?? '').includes('dshtc-preset') &&
      String(entry.attrs.className ?? '').includes('is-on'),
  )
  expect('高亮的就是最后点的那套', textOf(onCard?.attrs.children?.[0]) === lastApplied, [lastApplied, textOf(onCard?.attrs.children?.[0])])

  // 手改一行之后，预设高亮应该消失（说明“完全一致”才算命中）
  const pickers = handlers.filter((entry) => entry.event === 'onChange' && entry.attrs.type === 'color')
  pickers[0].handler({ target: { value: '#010203' } })
  handlers = []
  hooks = []
  hookIndex = 0
  const after = render(React.createElement(state.registered.component, {}))
  expect('微调后不再命中任何预设', (after.match(/dshtc-preset is-on/g) || []).length === 0)
}

// ---------- 用例 8：浅色预设（主题服务报告当前是浅色） ----------
group('浅色预设')
{
  const { moduleFace, storage } = loadPlugin(JSON.stringify({ enabled: true, dark: {}, light: {} }))
  const { ctx, state } = makeContext('light')
  moduleFace.apply(ctx)

  handlers = []
  hooks = []
  hookIndex = 0
  render(React.createElement(state.registered.component, {}))
  const modes = handlers.filter(
    (entry) => entry.event === 'onClick' && String(entry.attrs.className ?? '').startsWith('dshtc-mode'),
  )
  const onTab = modes.find((entry) => String(entry.attrs.className ?? '').includes('is-on'))
  expect('默认编辑浅色（跟随当前配色）', textOf(onTab?.attrs.children?.[0]) === 'modeLight', textOf(onTab?.attrs.children?.[0]))

  const cards = handlers.filter(
    (entry) => entry.event === 'onClick' && String(entry.attrs.className ?? '').startsWith('dshtc-preset'),
  )
  expect('渲染出 8 套浅色预设', cards.length === 8, cards.length)

  const rows = []
  let contrastFailures = 0
  let incomplete = 0
  let contaminated = 0

  for (const card of cards) {
    const name = textOf(card.attrs.children?.[0]) || '(未命名)'
    card.handler({})
    const payload = state.overrides[state.overrides.length - 1]?.tokens ?? {}
    const light = {}
    for (const [token, pair] of Object.entries(payload)) light[token] = pair.light
    if (Object.keys(light).length !== 11) incomplete += 1
    // 覆盖浅色侧时，深色侧必须还是官方原值（两侧互不污染）。
    if (payload['--dsw-alias-bg-base']?.dark !== '#151517') contaminated += 1
    const bg = light['--dsw-alias-bg-base']
    const checks = [
      // 底色不要纯白：亮度压在 0.6–0.92，比官方浅色（亮度 1.0）柔和
      luminance(bg) >= 0.6,
      luminance(bg) <= 0.92,
      contrast(light['--dsw-alias-label-primary'], bg) >= 7,
      contrast(light['--dsw-alias-label-primary'], bg) <= 13,
      contrast(light['--dsw-alias-label-secondary'], bg) >= 4.5,
      contrast(light['--dsw-alias-label-secondary'], bg) < contrast(light['--dsw-alias-label-primary'], bg),
      contrast(light['--dsw-alias-state-business-primary'], bg) >= 4.5,
      contrast(light['--dsw-alias-state-business-primary'], bg) <= 9,
      contrast(light['--dsw-alias-label-primary'], light['--dsw-alias-bg-layer-2']) >= 5,
      // 浅色下品牌色是深底 + 反白字
      contrast(light['--dsw-alias-brand-primary'], '#ffffff') >= 4.5,
    ]
    if (checks.some((ok) => !ok)) contrastFailures += 1
    rows.push({
      name,
      bg,
      正文: contrast(light['--dsw-alias-label-primary'], bg).toFixed(2),
      次要: contrast(light['--dsw-alias-label-secondary'], bg).toFixed(2),
      链接: contrast(light['--dsw-alias-state-business-primary'], bg).toFixed(2),
    })
  }

  expect('每套都覆盖全部 11 个 token', incomplete === 0, incomplete)
  expect('每套的对比度都在护眼区间内', contrastFailures === 0, contrastFailures)
  expect('浅色预设不影响深色侧', contaminated === 0, contaminated)
  expect('8 套底色互不相同', new Set(rows.map((row) => row.bg)).size === 8, rows.map((row) => row.bg))
  expect('底色都不是纯白', rows.every((row) => row.bg.toLowerCase() !== '#ffffff'), rows.map((row) => row.bg))
  expect('持久化进 light 一侧', Object.keys(JSON.parse(storage.get('dsh-theme-colors/v1')).light).length === 11)
  expect('深色侧仍是空的', Object.keys(JSON.parse(storage.get('dsh-theme-colors/v1')).dark).length === 0)
  console.log('  浅色预设概览：')
  for (const row of rows) {
    console.log(`    ${row.name.padEnd(24)} 底 ${row.bg}  正文/底 ${row.正文}  次要/底 ${row.次要}  链接/底 ${row.链接}`)
  }

  // 深浅两侧各存各的：切到深色 tab 点一套，浅色那份原样保留
  const lightBefore = JSON.parse(storage.get('dsh-theme-colors/v1')).light
  const darkTab = modes.find((entry) => textOf(entry.attrs.children?.[0]) === 'modeDark')
  expect('找到深色 tab', darkTab !== undefined)
  darkTab.handler({})
  handlers = []
  hooks = []
  hookIndex = 0
  render(React.createElement(state.registered.component, {}))
  const darkCards = handlers.filter(
    (entry) => entry.event === 'onClick' && String(entry.attrs.className ?? '').startsWith('dshtc-preset'),
  )
  expect('切到深色后渲染 7 套深色预设', darkCards.length === 7, darkCards.length)
  darkCards[0].handler({})
  const saved = JSON.parse(storage.get('dsh-theme-colors/v1'))
  expect('浅色那份原样保留', JSON.stringify(saved.light) === JSON.stringify(lightBefore))
  expect('深色那份也写了进去', Object.keys(saved.dark).length === 11, Object.keys(saved.dark).length)
}

// ---------- 用例 9：模式切换与跟随 ----------
group('模式切换与跟随')
{
  const { moduleFace } = loadPlugin(JSON.stringify({ enabled: true, dark: {}, light: {} }))
  const { ctx, state } = makeContext('dark')
  moduleFace.apply(ctx)

  // 第一次渲染：跟随主题 = 深色
  handlers = []
  hooks = []
  hookIndex = 0
  let html = render(React.createElement(state.registered.component, {}))
  const countCards = () => (html.match(/className="dshtc-preset[ "]/g) || []).length
  expect('深色主题下渲染 7 套深色预设', countCards() === 7, countCards())

  // 主题偏好切到浅色 → 用户没手动选过模式，设置页跟着跳到浅色
  switchScheme(state, 'light')
  handlers = []
  hooks = []
  hookIndex = 0
  html = render(React.createElement(state.registered.component, {}))
  expect('主题切浅色后自动跟着切', countCards() === 8, countCards())

  // 手动点「深色」tab 之后钉住：主题再怎么变，设置页都停在深色
  const darkTab = handlers.find(
    (entry) => entry.event === 'onClick' && String(entry.attrs.className ?? '').includes('dshtc-mode'),
  )
  expect('找到深色 tab', textOf(darkTab?.attrs.children?.[0]) === 'modeDark', textOf(darkTab?.attrs.children?.[0]))
  darkTab.handler({})
  switchScheme(state, 'light')
  handlers = []
  hooks = []
  hookIndex = 0
  html = render(React.createElement(state.registered.component, {}))
  expect('手动选过模式后不再跟随', countCards() === 7, countCards())
}

// ---------- 用例 10：旧数据（只有 dark）照样能用 ----------
group('旧数据兼容')
{
  const { moduleFace } = loadPlugin(
    JSON.stringify({ enabled: true, dark: { '--dsw-alias-bg-base': '#101010', '--dsw-alias-label-primary': '#eeeeee' } }),
  )
  const { ctx, state } = makeContext('light')
  moduleFace.apply(ctx)
  const tokens = state.overrides[0]?.tokens ?? {}
  expect('旧记录的两项照常生效', Object.keys(tokens).length === 2, Object.keys(tokens))
  expect('深色值来自旧记录', tokens['--dsw-alias-bg-base']?.dark === '#101010', tokens['--dsw-alias-bg-base'])
  expect('浅色侧补官方原值', tokens['--dsw-alias-bg-base']?.light === '#ffffff', tokens['--dsw-alias-bg-base'])

  handlers = []
  hooks = []
  hookIndex = 0
  const html = render(React.createElement(state.registered.component, {}))
  expect('浅色侧没有改动 → 显示官方浅色默认值', html.includes('value="#ffffff"'), html.slice(0, 0))
  expect('浅色侧没有改动 → 没有重置按钮', !html.includes('>reset<'))
  // 改动计数分模式显示：改动都在深色侧，所以只有深色 tab 带数字气泡
  expect('计数气泡只出现在改动过的那一侧', (html.match(/className="dshtc-modeCount"/g) || []).length === 1, (html.match(/className="dshtc-modeCount"/g) || []).length)
}

// ---------- 用例 11：样式护栏 ----------
group('样式护栏')
{
  const { moduleFace } = loadPlugin()
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  handlers = []
  hooks = []
  hookIndex = 0
  const html = render(React.createElement(state.registered.component, {}))
  const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) || [])[1] ?? ''
  expect('样式随组件一起渲染', css.length > 500, css.length)
  // 宿主 token 是唯一合法的颜色来源：写死颜色会在换主题时崩掉
  expect('无硬编码十六进制颜色', !/dshtc-[\w-]*[^{]*\{[^}]*:\s*#/.test(css))
  expect('无硬编码 rgb()/hsl() 颜色', !/dshtc-[\w-]*[^{]*\{[^}]*:\s*(?:rgb|hsl)a?\(/.test(css))
  const vars = [...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1])
  const strayVars = [...new Set(vars.filter((name) => !/^--(?:dsw-alias|dsw-specific|ds-font)-/.test(name)))]
  expect('只引用宿主放行的 token 家族', strayVars.length === 0, strayVars)
  expect('确实用到了宿主 token', vars.length > 0, vars.length)
  // 只看选择器的「第一个」类名：`.dshtc-preset.is-on` 里的 is-on 是状态类，不要求前缀
  const classes = [...new Set([...css.matchAll(/(?<![\w-])\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]))]
  expect('类名全部带 dshtc- 前缀', classes.every((name) => name.startsWith('dshtc-')), classes.filter((name) => !name.startsWith('dshtc-')))
  expect('类名数量合理（护栏本身没写空）', classes.length >= 25, classes.length)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
