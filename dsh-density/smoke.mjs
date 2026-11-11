/**
 * dsh-density Client / Host 两半的本地冒烟测试。
 *
 * 在 Node 里用极简 React 跑一遍：注册契约、默认紧凑排版、token 覆盖层的内容、
 * 预设/滑杆/字号步进、工作区自动配色/取色/恢复自动、localStorage 清洗、
 * CSS 护栏与卸载清理。
 * Client 半是手写 bundle，跑不了 TypeScript 检查，这个脚本就是提交前的护栏。
 */
import fs from 'node:fs'
import vm from 'node:vm'

const CLIENT = new URL('./client.js', import.meta.url)
const HOST = new URL('./index.js', import.meta.url)
const STORAGE_KEY = 'dsh-density/v1'
const WORKSPACE_STORAGE_KEY = 'dsh-density/workspace-colors/v1'

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
function loadPlugin(stored, workspaceStored) {
  let captured = null
  const storage = new Map()
  if (stored !== undefined) storage.set(STORAGE_KEY, stored)
  if (workspaceStored !== undefined) storage.set(WORKSPACE_STORAGE_KEY, workspaceStored)
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  }
  const styleElements = []
  const document = {
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        textContent: '',
        dataset: {},
        isConnected: false,
        remove() { this.isConnected = false },
      }
    },
    head: {
      appendChild(element) {
        element.isConnected = true
        styleElements.push(element)
        return element
      },
    },
  }
  const sandboxWindow = {
    localStorage,
    document,
    __ModuleLoader__: { load: (definition) => { captured = definition } },
  }
  const context = vm.createContext({ window: sandboxWindow, document, console, React })
  context.globalThis = context
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), context, { filename: 'client.js' })
  if (captured === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  const moduleFace = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require("${name}")`)
  })
  return { definition: captured, moduleFace, storage, styleElements }
}

function makeContext() {
  const state = {
    overrides: [],
    active: null,
    disposed: 0,
    registered: null,
    dictionaries: null,
    listeners: [],
    effects: [],
    fontSizes: { text: 13, code: 11 },
    fontCalls: [],
    scheme: 'light',
    registrations: [],
    workspaceRegistered: null,
    workspaceListeners: [],
    workspaceItems: [
      {
        workspaceId: 'ws-alpha',
        title: 'crm19',
        path: 'D:\\code\\php\\crm19',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        workspaceId: 'ws-beta',
        title: 'crm-mtds',
        path: 'D:\\code\\php\\crm-mtds',
        createdAt: '2026-02-01T00:00:00.000Z',
      },
      {
        workspaceId: 'ws-gamma',
        title: 'dsh-plugins',
        path: 'D:\\code\\plugins\\deepseekHarnessPlugins',
        createdAt: '2026-03-01T00:00:00.000Z',
      },
    ],
  }
  const workspaceStore = {
    getSnapshot: () => ({
      items: state.workspaceItems,
      archivedSessionIds: [],
      pinnedSessionIds: [],
      state: 'ready',
      phase: 'ready',
      error: null,
    }),
    subscribe: (listener) => {
      state.workspaceListeners.push(listener)
      return () => {
        state.workspaceListeners = state.workspaceListeners.filter((item) => item !== listener)
      }
    },
  }
  const ctx = {
    get: (name) => (name === 'workspaces' ? { list: workspaceStore } : undefined),
    locale: {
      bind: () => (key) => key,
      register: (ns, dict) => { state.dictionaries = { ns, dict }; return () => {} },
    },
    slots: {
      inject: (name, callback) => { state.injectName = name; callback() },
      register: (options, component) => {
        const entry = { options, component }
        state.registrations.push(entry)
        if (options.id === 'density') state.registered = entry
        if (options.id === 'workspace-colors') state.workspaceRegistered = entry
        return () => {}
      },
    },
    theme: {
      overrideTokens: (source, tokens) => {
        const layer = { source, tokens }
        state.overrides.push(layer)
        state.active = layer
        return () => {
          if (state.active !== layer) return
          state.active = null
          state.disposed += 1
        }
      },
      getTheme: () => ({ active: { colorScheme: state.scheme }, fontSizes: state.fontSizes }),
      setFontSize: (role, px) => {
        state.fontCalls.push([role, px])
        state.fontSizes[role] = px
        for (const entry of [...state.listeners]) {
          if (entry.name === 'theme/change') entry.handler({ fontSizes: { ...state.fontSizes } })
        }
      },
    },
    on: (name, handler) => {
      const entry = { name, handler }
      state.listeners.push(entry)
      return () => { state.listeners = state.listeners.filter((item) => item !== entry) }
    },
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') state.effects.push(cleanup)
    },
  }
  return { ctx, state }
}

function renderSection(state, id = 'density') {
  const entry = state.registrations.find((item) => item.options.id === id)
  if (entry === undefined) throw new Error(`没有注册设置页 ${id}`)
  handlers = []
  hooks = []
  hookIndex = 0
  const html = render(React.createElement(entry.component, {}))
  const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) || [])[1] ?? ''
  return { html, css }
}

function styleByKind(styleElements, kind) {
  return styleElements.filter((element) => element.dataset.dshDensity === kind).at(-1)
}

function cssColorFor(css, id) {
  const index = css.indexOf(`data-row-key="workspace:${id}"`)
  if (index === -1) return null
  return /background: (#[0-9a-f]{6});/.exec(css.slice(index))?.[1] ?? null
}

function cssGroupColorFor(css, id) {
  const marker = `div[class*="_groupSection"]:has(> [data-row-key="workspace:${id}"], > * > [data-row-key="workspace:${id}"])`
  const index = css.indexOf(marker)
  if (index === -1) return null
  return /background-color: (rgba\([^)]*\));/.exec(css.slice(index))?.[1] ?? null
}

function setWorkspaceItems(state, items) {
  state.workspaceItems = items
  for (const listener of [...state.workspaceListeners]) listener()
}

function handlerFor(event, predicate) {
  return handlers.find((entry) => entry.event === event && predicate(entry.attrs))
}

function clickPreset(state, id) {
  const entry = handlerFor('onClick', (attrs) => attrs['data-preset'] === id)
  if (entry === undefined) throw new Error(`没有找到预设按钮 ${id}`)
  entry.handler({})
}

function setRange(state, setting, value) {
  const entry = handlerFor('onChange', (attrs) => attrs['data-setting'] === setting)
  if (entry === undefined) throw new Error(`没有找到滑杆 ${setting}`)
  entry.handler({ target: { value: String(value) } })
}

function setEnabled(state, value) {
  const entry = handlerFor('onChange', (attrs) => attrs.type === 'checkbox')
  if (entry === undefined) throw new Error('没有找到启用开关')
  entry.handler({ target: { checked: value } })
}

function clickSidebar(state, id) {
  const entry = handlerFor('onClick', (attrs) => attrs['data-sidebar'] === id)
  if (entry === undefined) throw new Error(`没有找到侧栏预设 ${id}`)
  entry.handler({})
}

function clickAction(state, action) {
  const entry = handlerFor('onClick', (attrs) => attrs['data-action'] === action)
  if (entry === undefined) throw new Error(`没有找到按钮 ${action}`)
  entry.handler({})
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`)
    return true
  }
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  return false
}

let failures = 0
function group(title) {
  console.log(`\n== ${title} ==`)
}
function expect(label, condition, detail) {
  if (!check(label, condition, detail)) failures += 1
}

function baseToken(state) {
  return state.active?.tokens['--dsw-font-markdown-base']?.light ?? ''
}

function gapToken(state) {
  return state.active?.tokens['--dsh-chat-flow-gap']?.light ?? ''
}

// ---------- 用例 1：Host 与注册契约 ----------
group('Host 与注册契约')
{
  const host = await import(HOST)
  expect('Host 导出的 name 与 patch id 一致', host.name === 'density', host.name)
  expect('Host 导出 apply', typeof host.apply === 'function')
  const logs = []
  host.apply({ logger: { info: (...args) => logs.push(args) } })
  expect('Host 启动日志只打一条', logs.length === 1, logs.length)

  const { definition, moduleFace } = loadPlugin()
  expect('module id 与包名一致', definition.id === '@local/dsh-density', definition.id)
  expect(
    'inject 含 slots/locale/theme/workspaces',
    JSON.stringify(moduleFace.inject) === JSON.stringify(['slots', 'locale', 'theme', 'workspaces']),
    moduleFace.inject,
  )

  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  expect('注册到 settings.section', state.injectName === 'settings.section', state.injectName)
  expect('注册了两个设置页', state.registrations.length === 2, state.registrations.length)
  expect('设置页 id 为 density', state.registered?.options.id === 'density', state.registered?.options)
  expect('设置页 order 为 6', state.registered?.options.order === 6, state.registered?.options.order)
  expect('设置页 locale 为 density', state.registered?.options.locale === 'density')
  expect('label 是零参函数', typeof state.registered?.options.label === 'function')
  expect('label 走 dictionary', state.registered?.options.label() === 'nav')
  expect(
    '配色页 id/order 正确',
    state.workspaceRegistered?.options.id === 'workspace-colors' &&
      state.workspaceRegistered?.options.order === 7,
    state.workspaceRegistered?.options,
  )
  expect('配色页 label 走 dictionary', state.workspaceRegistered?.options.label() === 'workspaceNav')
  expect('配色页 locale 为 density', state.workspaceRegistered?.options.locale === 'density')

  const dictionaries = state.dictionaries?.dict
  expect('注册了 density 字典', state.dictionaries?.ns === 'density')
  expect('字典同时有 zh 与 en', Boolean(dictionaries?.zh) && Boolean(dictionaries?.en))
  const zhKeys = Object.keys(dictionaries.zh).sort()
  const enKeys = Object.keys(dictionaries.en).sort()
  expect('zh/en 键一致', JSON.stringify(zhKeys) === JSON.stringify(enKeys))
  expect('中英文都有 nav', dictionaries.zh.nav !== undefined && dictionaries.en.nav !== undefined)
}

// ---------- 用例 2：默认紧凑排版 ----------
group('默认紧凑排版')
{
  const { moduleFace } = loadPlugin()
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  expect('默认已应用一层覆盖', state.active !== null)
  expect('来源固定为 dsh-density', state.active?.source === 'dsh-density', state.active?.source)

  const tokens = state.active?.tokens ?? {}
  expect('覆盖 15 个 token', Object.keys(tokens).length === 15, Object.keys(tokens).length)
  const malformed = Object.entries(tokens).filter(
    ([, value]) => typeof value?.light !== 'string' || typeof value?.dark !== 'string',
  )
  expect('每个 token 都是 { light, dark }', malformed.length === 0, malformed)

  expect('默认正文行高 1.5', baseToken(state).includes('/ 1.5 '), baseToken(state))
  expect('正文 token 跟随官方字号', baseToken(state).includes('var(--dsh-content-font-size, 14px)'))
  expect('默认消息间距 3px', gapToken(state) === '3px', gapToken(state))
  expect(
    '表格 token 跟随次级字号',
    String(tokens['--dsw-font-markdown-table']?.light).includes('var(--dsh-content-font-size-secondary, 13px)'),
  )
  expect('h4 token 带 600 字重', String(tokens['--dsw-font-markdown-h4']?.light).startsWith('600 '))
  expect(
    '单独行高 token 用 calc',
    String(tokens['--dsw-font-markdown-base-line-height']?.light).includes('calc('),
  )
  expect(
    '排版值里没有颜色',
    Object.values(tokens).every(({ light, dark }) => !/#|rgba?\(|hsla?\(/.test(`${light}${dark}`)),
  )
}

// ---------- 用例 3：侧栏密度 ----------
group('侧栏密度')
{
  const { moduleFace, styleElements } = loadPlugin()
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  expect('默认注入侧栏样式', styleByKind(styleElements, 'sidebar') !== undefined)
  const css = styleByKind(styleElements, 'sidebar')?.textContent ?? ''
  expect('侧栏样式有作用域', css.includes('[data-slot="sidebar"]'))
  expect('会话行高 24px', css.includes('[data-row-key^="session:"]') && css.includes('height: 24px'))
  expect('工作区行高 26px', css.includes('height: 26px'))
  expect('面板行高 28px', css.includes('min-height: 28px'))
  expect('没有硬编码颜色', !/#|rgba?\(|hsla?\(/.test(css))
  const escaped = css
    .split('}')
    .map((rule) => rule.trim())
    .filter((rule) => rule.includes('{'))
    .filter((rule) => !rule.startsWith('/*') && !rule.startsWith('[data-slot="sidebar"]'))
  expect('所有规则限定在侧栏内', escaped.length === 0, escaped.slice(0, 2))

  renderSection(state)
  clickSidebar(state, 'dense')
  const denseCss = styleByKind(styleElements, 'sidebar')?.textContent ?? ''
  expect('更紧凑会话行高 22px', denseCss.includes('height: 22px'))
  expect('更紧凑工作区行高 24px', denseCss.includes('height: 24px'))
  expect('更紧凑仍然只作用于侧栏', denseCss.includes('[data-slot="sidebar"]'))

  renderSection(state)
  clickSidebar(state, 'off')
  expect('切到官方后移除样式节点', styleByKind(styleElements, 'sidebar')?.isConnected === false)

  renderSection(state)
  clickSidebar(state, 'compact')
  expect('切回紧凑后重新注入', styleByKind(styleElements, 'sidebar')?.isConnected === true)
  expect(
    '切回紧凑恢复 24px',
    (styleByKind(styleElements, 'sidebar')?.textContent ?? '').includes('height: 24px'),
  )
}

// ---------- 用例 4：设置页渲染 ----------
group('设置页渲染')
{
  const { moduleFace } = loadPlugin()
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  const { html, css } = renderSection(state)

  expect('渲染出根节点', html.includes('dshtd-root'))
  expect('渲染出 3 个预设', (html.match(/data-preset="/g) || []).length === 3,
    (html.match(/data-preset="/g) || []).length)
  expect('紧凑预设高亮', /data-preset="compact"[^>]*aria-pressed="true"/.test(html))
  expect('只有正文预设高亮', (html.match(/data-preset="[^"]+"[^>]*aria-pressed="true"/g) || []).length === 1)
  expect('渲染出 3 个侧栏预设', (html.match(/data-sidebar="/g) || []).length === 3,
    (html.match(/data-sidebar="/g) || []).length)
  expect('侧栏默认选中紧凑', /data-sidebar="compact"[^>]*aria-pressed="true"/.test(html))
  expect('渲染出侧栏卡片标题', html.includes('sidebarTitle'))
  expect('渲染出 2 个滑杆', (html.match(/className="dshtd-range"/g) || []).length === 2)
  expect('行高滑杆有 data-setting', html.includes('data-setting="lineHeight"'))
  expect('间距滑杆有 data-setting', html.includes('data-setting="flowGap"'))
  expect('字号读数跟随主题快照', html.includes('data-role="text-value">13px'))
  expect('代码字号读数跟随主题快照', html.includes('data-role="code-value">11px'))
  expect('预览渲染两段', (html.match(/className="dshtd-previewText"/g) || []).length === 2)
  expect('徽标显示 1.50×', html.includes('1.50×'))
  expect('没有出现 noTheme 警告', !html.includes('noTheme'))
  expect('样式里包含 box-sizing reset', css.includes('box-sizing:border-box'))
}

// ---------- 用例 4：滑杆与预设 ----------
group('滑杆与预设')
{
  const { moduleFace, storage } = loadPlugin()
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  renderSection(state)

  setRange(state, 'lineHeight', 1.4)
  expect('行高写入 1.4', baseToken(state).includes('/ 1.4 '), baseToken(state))
  expect('旧覆盖层被释放', state.disposed === 1, state.disposed)
  const stored = JSON.parse(storage.get(STORAGE_KEY))
  expect('行高已持久化', stored.lineHeight === 1.4 && stored.enabled === true, stored)

  const afterSlider = renderSection(state).html
  expect('微调后不再命中正文预设', !/data-preset="[^"]+"[^>]*aria-pressed="true"/.test(afterSlider))
  expect('侧栏预设不受正文微调影响', /data-sidebar="compact"[^>]*aria-pressed="true"/.test(afterSlider))
  expect('徽标显示 1.40×', afterSlider.includes('1.40×'))

  setRange(state, 'flowGap', 0)
  expect('间距写入 0px', gapToken(state) === '0px', gapToken(state))

  clickPreset(state, 'dense')
  expect('极紧凑预设写入 1.38', baseToken(state).includes('/ 1.38 '), baseToken(state))
  expect('极紧凑预设写入 1px', gapToken(state) === '1px', gapToken(state))
  const denseHtml = renderSection(state).html
  expect('极紧凑预设高亮', /data-preset="dense"[^>]*aria-pressed="true"/.test(denseHtml))

  clickPreset(state, 'official')
  expect('官方预设关闭覆盖层', state.active === null)
  const officialHtml = renderSection(state).html
  expect('官方预设高亮', /data-preset="official"[^>]*aria-pressed="true"/.test(officialHtml))
  expect('关闭后显示官方徽标', officialHtml.includes('>pOfficial<'))

  clickPreset(state, 'compact')
  expect('紧凑预设重新应用', state.active !== null && baseToken(state).includes('/ 1.5 '))
}

// ---------- 用例 5：启用开关 ----------
group('启用开关')
{
  const { moduleFace } = loadPlugin()
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  renderSection(state)

  setEnabled(state, false)
  expect('关闭后移除覆盖层', state.active === null)
  const offHtml = renderSection(state).html
  expect('关闭后显示官方徽标', offHtml.includes('>pOfficial<'))

  setEnabled(state, true)
  expect('重新打开后恢复行高', baseToken(state).includes('/ 1.5 '), baseToken(state))
  expect('重新打开保留消息间距', gapToken(state) === '3px', gapToken(state))
}

// ---------- 用例 6：字号步进 ----------
group('字号步进')
{
  const { moduleFace } = loadPlugin()
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  let { html } = renderSection(state)
  expect('正文初始 13px', html.includes('data-role="text-value">13px'))

  clickAction(state, 'text-increase')
  expect('正文 +1 调用官方服务', JSON.stringify(state.fontCalls.at(-1)) === JSON.stringify(['text', 14]), state.fontCalls)
  html = renderSection(state).html
  expect('正文读数变成 14px', html.includes('data-role="text-value">14px'))

  clickAction(state, 'code-increase')
  expect('代码 +1 调用官方服务', JSON.stringify(state.fontCalls.at(-1)) === JSON.stringify(['code', 12]), state.fontCalls)
  html = renderSection(state).html
  expect('代码读数变成 12px', html.includes('data-role="code-value">12px'))

  state.fontSizes.text = 22
  renderSection(state)
  clickAction(state, 'text-increase')
  expect('正文不会超过 22', state.fontSizes.text === 22, state.fontSizes.text)
}

// ---------- 用例 7：持久化清洗 ----------
group('持久化清洗')
{
  {
    const { moduleFace } = loadPlugin(JSON.stringify({ enabled: true, lineHeight: 2.5, flowGap: -3 }))
    const { ctx, state } = makeContext()
    moduleFace.apply(ctx)
    expect('超范围行高夹到 1.8', baseToken(state).includes('/ 1.8 '), baseToken(state))
    expect('负间距夹到 0px', gapToken(state) === '0px', gapToken(state))
  }
  {
    const { moduleFace } = loadPlugin('{坏掉的数据')
    const { ctx, state } = makeContext()
    moduleFace.apply(ctx)
    expect('坏数据回退默认 1.5', baseToken(state).includes('/ 1.5 '))
    expect('坏数据回退默认 3px', gapToken(state) === '3px')
  }
  {
    const { moduleFace } = loadPlugin(JSON.stringify({ enabled: false, lineHeight: 1.6, flowGap: 4 }))
    const { ctx, state } = makeContext()
    moduleFace.apply(ctx)
    expect('关闭状态不建层', state.active === null)
    renderSection(state)
    setEnabled(state, true)
    expect('重新打开读回 1.6', baseToken(state).includes('/ 1.6 '), baseToken(state))
    expect('重新打开读回 4px', gapToken(state) === '4px', gapToken(state))
  }
  {
    const { moduleFace } = loadPlugin(JSON.stringify({ lineHeight: '1.6', flowGap: '4' }))
    const { ctx, state } = makeContext()
    moduleFace.apply(ctx)
    expect('字符串数值也能清洗', baseToken(state).includes('/ 1.6 ') && gapToken(state) === '4px')
  }
  {
    const { moduleFace, styleElements } = loadPlugin(JSON.stringify({ sidebar: 'dense' }))
    const { ctx } = makeContext()
    moduleFace.apply(ctx)
    expect(
      '侧栏偏好能持久化',
      (styleByKind(styleElements, 'sidebar')?.textContent ?? '').includes('height: 22px'),
    )
  }
  {
    const { moduleFace, styleElements } = loadPlugin(JSON.stringify({ sidebar: '乱写' }))
    const { ctx } = makeContext()
    moduleFace.apply(ctx)
    expect(
      '侧栏脏数据回退紧凑',
      (styleByKind(styleElements, 'sidebar')?.textContent ?? '').includes('height: 24px'),
    )
  }
  {
    const { moduleFace, styleElements } = loadPlugin(JSON.stringify({ enabled: false }))
    const { ctx } = makeContext()
    moduleFace.apply(ctx)
    expect('关闭正文不影响侧栏样式', styleByKind(styleElements, 'sidebar')?.isConnected === true)
  }
}

// ---------- 用例 8：卸载清理 ----------
group('卸载清理')
{
  const { moduleFace, styleElements } = loadPlugin()
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  expect('应用后存在覆盖层', state.active !== null)
  expect('应用后存在侧栏样式', styleByKind(styleElements, 'sidebar')?.isConnected === true)
  expect('应用后存在配色样式', styleByKind(styleElements, 'workspace-colors')?.isConnected === true)
  for (const cleanup of state.effects) cleanup()
  expect('卸载后覆盖层被移除', state.active === null)
  expect('卸载后侧栏样式被移除', styleByKind(styleElements, 'sidebar')?.isConnected === false)
  expect('卸载后配色样式被移除', styleByKind(styleElements, 'workspace-colors')?.isConnected === false)
}

// ---------- 用例 9：工作区配色 ----------
group('工作区配色')
{
  const { moduleFace, styleElements } = loadPlugin()
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  const css = styleByKind(styleElements, 'workspace-colors')?.textContent ?? ''
  expect('默认注入工作区配色样式', css.length > 0)
  for (const id of ['ws-alpha', 'ws-beta', 'ws-gamma']) {
    expect(`命中 ${id} 的工作区行`, css.includes(`data-row-key="workspace:${id}"`))
  }
  const colors = [...css.matchAll(/background: (#[0-9a-f]{6});/g)].map((match) => match[1])
  expect('三个工作区都分到颜色', colors.length === 3, colors)
  expect('默认颜色互不相同', new Set(colors).size === 3, colors)
  expect('只命中工作区行', !css.includes('data-row-key="session:'))
  expect('配色作用域在侧栏', css.includes('[data-slot="sidebar"]'))
  expect('目录行用伪元素铺深色', css.includes('::before') && css.includes('opacity: 0.24'))
  expect('没有写死会话行规则', !css.includes('[data-row-key^="session:"]'), css)

  const groupColors = ['ws-alpha', 'ws-beta', 'ws-gamma'].map((id) => cssGroupColorFor(css, id))
  expect('每个工作区整组都有浅色底', groupColors.every((value) => value !== null), groupColors)
  expect('整组颜色互不相同', new Set(groupColors).size === 3, groupColors)
  expect('整组浅色透明度为 16%', groupColors.every((value) => value.endsWith(', 0.16)')), groupColors)
  expect(
    '整组选择器兼容 HoverCard 包裹层',
    css.includes('div[class*="_groupSection"]:has(> [data-row-key="workspace:') &&
      css.includes(', > * > [data-row-key="workspace:'),
  )

  const { html } = renderSection(state, 'workspace-colors')
  expect('渲染配色设置页', html.includes('dshtd-root') && html.includes('workspaceTitle'))
  expect('渲染 3 个颜色输入', (html.match(/data-workspace-color="/g) || []).length === 3)
  expect('颜色输入带 hex 值', (html.match(/value="#[0-9a-f]{6}"/g) || []).length === 3)
  expect('默认显示自动标签', html.includes('workspaceAuto'))
  expect('渲染启用开关', html.includes('data-setting="workspace-colors-enabled"'))
  expect('默认启用', /data-setting="workspace-colors-enabled"[^>]*checked/.test(html))
}

// ---------- 用例 10：工作区配色交互 ----------
group('工作区配色交互')
{
  const { moduleFace, styleElements, storage } = loadPlugin()
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  renderSection(state, 'workspace-colors')

  const colorHandler = handlerFor(
    'onChange',
    (attrs) => attrs['data-workspace-color'] === 'ws-alpha',
  )
  expect('找到 ws-alpha 的取色器', colorHandler !== undefined)
  let css = styleByKind(styleElements, 'workspace-colors')?.textContent ?? ''
  const betaColor = cssColorFor(css, 'ws-beta')
  const gammaColor = cssColorFor(css, 'ws-gamma')
  colorHandler.handler({ target: { value: betaColor } })
  css = styleByKind(styleElements, 'workspace-colors')?.textContent ?? ''
  expect('给 A 选 B 的自动色不会挤走 B', cssColorFor(css, 'ws-beta') === betaColor, css)
  expect('给 A 选 B 的自动色也不会挤走 C', cssColorFor(css, 'ws-gamma') === gammaColor, css)

  colorHandler.handler({ target: { value: '#123456' } })
  css = styleByKind(styleElements, 'workspace-colors')?.textContent ?? ''
  expect('自定义色写入工作区样式', css.includes('background: #123456;'), css)
  let stored = JSON.parse(storage.get(WORKSPACE_STORAGE_KEY))
  expect('自定义色已持久化', stored.colors['ws-alpha'] === '#123456', stored)

  let html = renderSection(state, 'workspace-colors').html
  expect('自定义工作区显示自定义标签', html.includes('workspaceCustom'))
  expect('出现恢复自动按钮', html.includes('data-workspace-auto="ws-alpha"'), html)

  const resetHandler = handlerFor(
    'onClick',
    (attrs) => attrs['data-workspace-auto'] === 'ws-alpha',
  )
  expect('找到恢复自动按钮', resetHandler !== undefined)
  resetHandler.handler({})
  css = styleByKind(styleElements, 'workspace-colors')?.textContent ?? ''
  expect('恢复自动后移除自定义色', !css.includes('background: #123456;'), css)
  stored = JSON.parse(storage.get(WORKSPACE_STORAGE_KEY))
  expect('恢复自动后删除持久化键', stored.colors['ws-alpha'] === undefined, stored)

  const oldStyle = styleByKind(styleElements, 'workspace-colors')
  const toggle = handlerFor(
    'onChange',
    (attrs) => attrs['data-setting'] === 'workspace-colors-enabled',
  )
  expect('找到配色启用开关', toggle !== undefined)
  toggle.handler({ target: { checked: false } })
  expect('关闭后移除配色样式', oldStyle?.isConnected === false)
  stored = JSON.parse(storage.get(WORKSPACE_STORAGE_KEY))
  expect('关闭状态已持久化', stored.enabled === false, stored)

  renderSection(state, 'workspace-colors')
  const toggleBack = handlerFor(
    'onChange',
    (attrs) => attrs['data-setting'] === 'workspace-colors-enabled',
  )
  toggleBack.handler({ target: { checked: true } })
  expect('重新打开后恢复配色样式', styleByKind(styleElements, 'workspace-colors')?.isConnected === true)

  setWorkspaceItems(state, [
    ...state.workspaceItems,
    {
      workspaceId: 'ws-delta',
      title: 'new-workspace',
      path: 'D:\\code\\new-workspace',
      createdAt: '2026-04-01T00:00:00.000Z',
    },
  ])
  css = styleByKind(styleElements, 'workspace-colors')?.textContent ?? ''
  expect('新增工作区自动加入配色', css.includes('data-row-key="workspace:ws-delta"'))
  const colors = [...css.matchAll(/background: (#[0-9a-f]{6});/g)].map((match) => match[1])
  expect('四个工作区颜色互不相同', new Set(colors).size === 4, colors)
  html = renderSection(state, 'workspace-colors').html
  expect('设置页跟随工作区列表更新', (html.match(/data-workspace-color="/g) || []).length === 4)
}

// ---------- 用例 11：工作区配色持久化与清洗 ----------
group('工作区配色持久化与清洗')
{
  {
    const { moduleFace, styleElements } = loadPlugin(
      undefined,
      JSON.stringify({ enabled: true, colors: { 'ws-beta': '#ABCDEF' } }),
    )
    const { ctx, state } = makeContext()
    moduleFace.apply(ctx)
    const css = styleByKind(styleElements, 'workspace-colors')?.textContent ?? ''
    expect('读回工作区自定义色', css.includes('background: #abcdef;'), css)
    const html = renderSection(state, 'workspace-colors').html
    expect('读回后显示自定义标签', html.includes('workspaceCustom'))
  }
  {
    const { moduleFace, styleElements } = loadPlugin(
      undefined,
      '{"enabled":"yes","colors":{"ws-alpha":"red","ws-beta":"#12345","ws-gamma":"#ABCDEF","__proto__":"#000000"}}',
    )
    const { ctx, state } = makeContext()
    moduleFace.apply(ctx)
    const css = styleByKind(styleElements, 'workspace-colors')?.textContent ?? ''
    expect('非法颜色被丢弃', !css.includes('red') && !css.includes('#12345'))
    expect('合法颜色保留并转小写', css.includes('background: #abcdef;'), css)
    expect('__proto__ 键被忽略', !css.includes('#000000'))
    expect('非布尔 enabled 回退为 true', css.length > 0)
    expect('设置页仍可渲染', renderSection(state, 'workspace-colors').html.includes('dshtd-root'))
  }
  {
    const { moduleFace, styleElements } = loadPlugin(
      undefined,
      JSON.stringify({ enabled: false, colors: { 'ws-alpha': '#123456' } }),
    )
    const { ctx, state } = makeContext()
    moduleFace.apply(ctx)
    expect('关闭时不注入配色样式', styleByKind(styleElements, 'workspace-colors') === undefined)
    const html = renderSection(state, 'workspace-colors').html
    expect(
      '关闭时开关未选中',
      !/data-setting="workspace-colors-enabled"[^>]*checked/.test(html),
      html,
    )
  }
}

// ---------- 用例 12：样式护栏 ----------
group('样式护栏')
{
  const { moduleFace } = loadPlugin()
  const { ctx, state } = makeContext()
  moduleFace.apply(ctx)
  const { css } = renderSection(state)

  expect('样式随组件一起渲染', css.length > 800, css.length)
  expect('无硬编码十六进制颜色', !/dshtd-[\w-]*[^{]*\{[^}]*:\s*#/.test(css))
  expect('无硬编码 rgb()/hsl() 颜色', !/dshtd-[\w-]*[^{]*\{[^}]*:\s*(?:rgb|hsl)a?\(/.test(css))
  const vars = [...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1])
  const strayVars = [...new Set(vars.filter((name) => !/^--(?:dsw-alias|dsw-specific|ds-font)-/.test(name)))]
  expect('只引用宿主放行的 token 家族', strayVars.length === 0, strayVars)
  expect('确实用到了宿主 token', vars.length > 0, vars.length)
  const classes = [...new Set([...css.matchAll(/(?<![\w-])\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]))]
  expect('类名全部带 dshtd- 前缀', classes.every((name) => name.startsWith('dshtd-')), classes.filter((name) => !name.startsWith('dshtd-')))
  expect('类名数量合理', classes.length >= 20, classes.length)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
