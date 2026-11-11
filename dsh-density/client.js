/**
 * 排版密度 —— Client 半。
 *
 * 设置 → 排版密度：在官方字号之外，单独收紧会话正文的行高/消息间距，
 * 并收紧左侧工作区/会话列表的行高、字号与内边距。
 * 官方正文样式把行高写成 `calc(24px + 字号增量)`，字号越小行高比例反而越大
 * （13px 字号仍有 23px 行高，约 1.77×），所以只调字号并不能把行距压下来；
 * 侧栏则把 32px 的会话行、34px 的工作区行压到 24/26px（更紧凑档 22/24px）。
 *
 * 生效方式：`ctx.theme.overrideTokens(source, tokens)`——ui-theme 的公开扩展点，
 * 把 `--dsw-font-markdown-base*` / 表格 / h4 字体 token 换成“字号 + 行高倍数”的
 * 形式；token 里引用 `--dsh-content-font-size`，所以官方字号变化会自动跟随。
 * 另外把 `--dsh-chat-flow-gap` 调小，收紧消息之间的空隙。
 *
 * 边界：只改 Markdown 正文、表格、h4 与消息间距；用户气泡、工具行等使用官方
 * `calc(22px + delta)` 的固定行高，保持不动，避免把图标和行高布局一起压坏。
 *
 * 持久化：localStorage（Desktop 的本地 origin 固定，跨重启有效）；
 * 字号本身仍由官方 `ui-theme` 设置持久化。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-density',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'density'
    /** token 覆盖层的来源标识；同一来源重复调用会整层替换。 */
    const SOURCE = 'dsh-density'
    const STORAGE_KEY = 'dsh-density/v1'

    const LINE_HEIGHT_MIN = 1.25
    const LINE_HEIGHT_MAX = 1.8
    const LINE_HEIGHT_STEP = 0.01
    const FLOW_GAP_MIN = 0
    const FLOW_GAP_MAX = 8

    /** 官方字号范围与默认值；与 ui-theme 的 FONT_SIZE_SPECS 保持一致。 */
    const FONT_RANGES = {
      text: [10, 22],
      code: [10, 16],
    }
    const FONT_DEFAULTS = { text: 14, code: 11 }

    /** 默认就是“紧凑”，装好后立刻能看到密度变化；官方预设则整层关闭。 */
    const DEFAULT_STATE = Object.freeze({ enabled: true, lineHeight: 1.5, flowGap: 3, sidebar: 'compact' })

    /** 侧栏三档：off 不注入样式，compact/dense 只收紧左侧工作区列表。 */
    const SIDEBAR_MODES = ['off', 'compact', 'dense']

    /**
     * 工作区配色与排版状态分开存：排版「恢复默认」不应该顺手清掉用户挑的颜色。
     * 颜色只存用户显式改过的工作区；没改过的按 ID 从色板自动分配。
     *
     * 色板是“用户颜色”而不是主题色，所以这里允许出现十六进制；设置页自身的
     * CSS 仍只用 `--dsw-alias-*` token，冒烟测试照旧按宿主 token 家族检查。
     */
    const WORKSPACE_STORAGE_KEY = 'dsh-density/workspace-colors/v1'
    const WORKSPACE_PALETTE = Object.freeze([
      '#e5484d',
      '#f76b15',
      '#f5b300',
      '#30a46c',
      '#12a594',
      '#0091ff',
      '#3e63dd',
      '#8e4ec6',
      '#d6409f',
      '#e93d82',
    ])

    /**
     * 侧栏预设。侧栏的行高/字号没有官方 token，插件注入一段作用域 CSS 来收紧；
     * 文案仍走 locale，数值由 buildSidebarCss() 统一生成。
     */
    const SIDEBAR_PRESETS = [
      { id: 'off', nameKey: 'sidebarOff', noteKey: 'sidebarOffNote' },
      { id: 'compact', nameKey: 'sidebarCompact', noteKey: 'sidebarCompactNote' },
      { id: 'dense', nameKey: 'sidebarDense', noteKey: 'sidebarDenseNote' },
    ]

    /**
     * 预设。official 关掉覆盖层；其余两档只改行高与消息间距，字号仍走官方设置。
     * “自定义”不在这里，由 presetId() 根据当前数值推导。
     */
    const PRESETS = [
      {
        id: 'official',
        nameKey: 'pOfficial',
        noteKey: 'pOfficialNote',
        enabled: false,
        lineHeight: 1.5,
        flowGap: 3,
      },
      {
        id: 'compact',
        nameKey: 'pCompact',
        noteKey: 'pCompactNote',
        enabled: true,
        lineHeight: 1.5,
        flowGap: 3,
      },
      {
        id: 'dense',
        nameKey: 'pDense',
        noteKey: 'pDenseNote',
        enabled: true,
        lineHeight: 1.38,
        flowGap: 1,
      },
    ]

    const zh = {
      nav: '排版密度',
      title: '界面排版密度',
      intro: '分两块：正文控制行高与消息间距，侧栏控制工作区/会话列表的密度。两边独立生效，字号仍走官方设置。',
      enabled: '启用正文紧凑排版',
      enableHint: '只影响会话正文；关掉后侧栏仍按下面的选择生效。',
      presetLabel: '预设',
      pOfficial: '官方',
      pOfficialNote: '保持 DSH 默认行高与间距',
      pCompact: '紧凑',
      pCompactNote: '行高 1.5×，适合大多数长会话',
      pDense: '极紧凑',
      pDenseNote: '行高 1.38×，信息密度优先',
      custom: '自定义',
      lineHeight: '正文行高',
      lineHeightDesc: '只作用于 Markdown 正文、表格与 h4，按钮和图标尺寸不变。',
      flowGap: '消息间距',
      flowGapDesc: '相邻消息与过程行之间的空隙；部分分组间距由官方样式固定，不会被压到 0。',
      sidebarTitle: '侧栏密度',
      sidebarDesc: '收紧左侧工作区的行高、字号和间距；只影响侧栏，不动主区与右侧栏。',
      sidebarOff: '官方',
      sidebarOffNote: '保持 DSH 默认侧栏',
      sidebarCompact: '紧凑',
      sidebarCompactNote: '行高 24px，一屏多显示 3 条会话',
      sidebarDense: '更紧凑',
      sidebarDenseNote: '行高 22px，信息密度优先',
      sidebarHint: '侧栏尺寸没有官方 token，这里注入一段只作用于 [data-slot="sidebar"] 的样式；官方改结构时最多失效，不会影响主区。',
      workspaceNav: '工作区配色',
      workspaceTitle: '工作区背景色',
      workspaceIntro: '每个工作区整组自动分配一种底色：目录行深一点、会话列表浅一点；也可以单独指定颜色。',
      workspaceEnabled: '启用工作区底色',
      workspaceEnabledHint: '只给左侧栏的工作区分组铺色：目录行深、会话列表浅；主区和右侧栏都不动。',
      workspaceAuto: '自动',
      workspaceCustom: '自定义',
      workspaceUseAuto: '恢复自动',
      workspaceAutoAll: '全部恢复自动',
      workspaceEmpty: '还没有工作区，或工作区服务尚未就绪。',
      workspaceUntitled: '未命名工作区',
      workspaceNoPath: '未提供路径',
      workspaceColorLabel: '工作区颜色',
      workspaceHint: '默认按工作区 ID 分配不同颜色；目录行 24%、会话列表 16% 叠色；超过 10 个工作区会循环色板，悬停或选中仍走官方样式。',
      workspaceServiceMissing: '未连接工作区服务，暂时读不到工作区列表；刷新页面后重试。',
      preview: '预览',
      previewP1: '这一段用当前行高渲染。行距收紧后，同一屏能多读几行，长回答不必频繁滚动。',
      previewP2: '第二段用来看段间距与换行效果；字号仍取自官方正文字号。',
      fontTitle: '字号',
      fontSizeText: '正文字号',
      fontSizeTextDesc: '与「通用 → 正文字号」是同一个值，10–22 px。',
      fontSizeCode: '代码字号',
      fontSizeCodeDesc: '与「通用 → 代码字号」同步，10–16 px。',
      fontSizeHint: '也可以直接按 Ctrl/Cmd + - 调整；这里和官方设置会互相同步。',
      scopeHint: '只改排版，不碰颜色、字体和图标；配色仍由「外观颜色」/主题负责。',
      storageHint: '偏好保存在本机浏览器，刷新与重启后保留。',
      resetAll: '恢复默认',
      noTheme: '没有检测到主题服务（ui-theme），行高无法应用。',
      decrease: '减小',
      increase: '增大',
    }

    const en = {
      nav: 'Layout density',
      title: 'Interface density',
      intro: 'Two independent parts: the conversation body controls line height and message spacing; the sidebar controls workspace and session list density. Font sizes still come from the official settings.',
      enabled: 'Enable compact conversation body',
      enableHint: 'Affects the conversation body only; the sidebar still follows the choice below.',
      presetLabel: 'Presets',
      pOfficial: 'Official',
      pOfficialNote: 'Keep the DSH default spacing',
      pCompact: 'Compact',
      pCompactNote: '1.5× line height, a good default for long chats',
      pDense: 'Dense',
      pDenseNote: '1.38× line height, information first',
      custom: 'Custom',
      lineHeight: 'Body line height',
      lineHeightDesc: 'Applies to Markdown body, tables and h4; button and icon sizes stay untouched.',
      flowGap: 'Message spacing',
      flowGapDesc: 'Gap between adjacent messages and process rows; some grouped gaps are fixed by the official styles and will not collapse to zero.',
      sidebarTitle: 'Sidebar density',
      sidebarDesc: 'Tightens row height, font size and spacing in the left workspace list; the main area and right sidebar are untouched.',
      sidebarOff: 'Official',
      sidebarOffNote: 'Keep the DSH default sidebar',
      sidebarCompact: 'Compact',
      sidebarCompactNote: '24px rows, about 3 more sessions per screen',
      sidebarDense: 'Dense',
      sidebarDenseNote: '22px rows, information first',
      sidebarHint: 'Sidebar metrics have no official tokens, so this injects a stylesheet scoped to [data-slot="sidebar"]; a future layout change can only make it stop applying, never break the main area.',
      workspaceNav: 'Workspace colors',
      workspaceTitle: 'Workspace background',
      workspaceIntro: 'Each workspace group gets its own tint: a deeper header and a lighter session list; you can override any color.',
      workspaceEnabled: 'Enable workspace tints',
      workspaceEnabledHint: 'Tint the whole workspace group in the left sidebar: deeper header, lighter sessions; the main area and right sidebar stay untouched.',
      workspaceAuto: 'Auto',
      workspaceCustom: 'Custom',
      workspaceUseAuto: 'Use auto',
      workspaceAutoAll: 'Auto for all',
      workspaceEmpty: 'No workspaces yet, or the workspace service is not ready.',
      workspaceUntitled: 'Untitled workspace',
      workspaceNoPath: 'No path',
      workspaceColorLabel: 'Workspace color',
      workspaceHint: 'Auto colors are derived from workspace IDs; headers use 24% and sessions 16%. More than 10 workspaces cycle the palette; hover and selection keep the official styles.',
      workspaceServiceMissing: 'The workspace service is not connected, so the list cannot be read yet. Refresh to retry.',
      preview: 'Preview',
      previewP1: 'This paragraph uses the current line height. Tighter leading means more lines per screen, so long answers need less scrolling.',
      previewP2: 'The second paragraph shows the paragraph gap and wrapping; the font size still comes from the official body size.',
      fontTitle: 'Font size',
      fontSizeText: 'Body font size',
      fontSizeTextDesc: 'Same value as General → Body font size, 10–22 px.',
      fontSizeCode: 'Code font size',
      fontSizeCodeDesc: 'Synced with General → Code font size, 10–16 px.',
      fontSizeHint: 'You can also press Ctrl/Cmd + -; this panel and the official settings stay in sync.',
      scopeHint: 'Typography only — colors, font family and icons are untouched; colors remain with Appearance colors / themes.',
      storageHint: 'Stored in this browser and kept across refresh and restart.',
      resetAll: 'Reset',
      noTheme: 'The theme service (ui-theme) is missing, so line height cannot be applied.',
      decrease: 'Decrease',
      increase: 'Increase',
    }

    /** 翻译函数由 apply 绑定；组件渲染时读取。 */
    let t = (key) => key
    /** 主题服务；由 apply 注入。 */
    let theme = null
    /** 当前 token 覆盖层的释放函数。 */
    let disposeLayer = null

    const CSS = `
.dshtd-root { display:flex; flex-direction:column; gap:12px; color:var(--dsw-alias-label-primary); font-size:13px; }
.dshtd-root *, .dshtd-root *::before, .dshtd-root *::after { box-sizing:border-box; }

.dshtd-head { display:flex; align-items:center; gap:8px; }
.dshtd-title { margin:0; font-size:14px; font-weight:600; }
.dshtd-badge { height:16px; padding:0 6px; border-radius:8px; font-size:10px; line-height:16px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); }
.dshtd-spacer { flex:1 1 auto; }
.dshtd-desc { margin:0; font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.dshtd-warn { margin:0; font-size:12px; line-height:18px; color:var(--dsw-alias-state-error-primary); }
.dshtd-foot { font-size:11px; line-height:16px; color:var(--dsw-alias-label-secondary); }

.dshtd-colorList { display:flex; flex-direction:column; margin-top:10px; }
.dshtd-colorRow { display:flex; align-items:center; gap:10px; min-width:0; padding:5px 0; }
.dshtd-colorRow + .dshtd-colorRow { border-top:.5px solid var(--dsw-alias-border-l1); }
.dshtd-colorInput { width:30px; height:30px; flex:0 0 auto; padding:0; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:transparent; cursor:pointer; }
.dshtd-colorInput::-webkit-color-swatch-wrapper { padding:0; }
.dshtd-colorInput::-webkit-color-swatch { border:none; border-radius:6px; }
.dshtd-colorText { min-width:0; flex:1 1 auto; display:flex; flex-direction:column; gap:1px; }
.dshtd-colorName { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; line-height:18px; }
.dshtd-colorPath { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; line-height:15px; color:var(--dsw-alias-label-tertiary); }
.dshtd-colorMeta { font-size:10px; line-height:14px; color:var(--dsw-alias-label-secondary); }
.dshtd-colorTag { display:inline-block; padding:0 5px; border-radius:6px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); }
.dshtd-colorAction { flex:0 0 auto; height:24px; padding:0 8px; font-size:11px; }
.dshtd-colorEmpty { margin-top:8px; font-size:12px; line-height:18px; color:var(--dsw-alias-label-tertiary); }

.dshtd-btn { height:26px; padding:0 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-secondary); font-size:12px; cursor:pointer; }
.dshtd-btn:hover:not(:disabled) { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dshtd-btn:disabled { opacity:.45; cursor:default; }

.dshtd-card { padding:12px 14px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-2); }
.dshtd-cardTitle { margin:0; font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }

.dshtd-switch { display:inline-flex; align-items:center; gap:8px; font-size:12px; color:var(--dsw-alias-label-primary); cursor:pointer; user-select:none; }
.dshtd-switch input { width:14px; height:14px; margin:0; accent-color:var(--dsw-alias-state-business-primary); cursor:pointer; }
.dshtd-hint { margin-top:6px; font-size:11px; line-height:16px; color:var(--dsw-alias-label-secondary); }

.dshtd-presets { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; margin-top:12px; }
.dshtd-preset { display:flex; flex-direction:column; gap:3px; padding:9px 10px; text-align:left; border-radius:10px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; cursor:pointer; }
.dshtd-preset:hover { border-color:var(--dsw-alias-border-l2); }
.dshtd-preset.is-on { border-color:var(--dsw-alias-state-business-primary); box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary); }
.dshtd-presetName { font-size:12px; font-weight:600; line-height:16px; }
.dshtd-presetNote { font-size:10px; line-height:14px; color:var(--dsw-alias-label-secondary); }

.dshtd-row { display:flex; align-items:center; gap:16px; padding:10px 0; border-bottom:.5px solid var(--dsw-alias-border-l2); }
.dshtd-row:last-of-type { border-bottom:none; }
.dshtd-rowText { display:flex; flex-direction:column; gap:2px; flex:1 1 auto; min-width:0; }
.dshtd-rowLabel { font-size:13px; line-height:20px; }
.dshtd-rowDesc { font-size:11px; line-height:16px; color:var(--dsw-alias-label-secondary); }

.dshtd-sliderControl { display:inline-flex; align-items:center; gap:8px; flex:0 0 auto; }
.dshtd-range { width:150px; margin:0; accent-color:var(--dsw-alias-state-business-primary); cursor:pointer; }
.dshtd-sliderValue { min-width:46px; text-align:right; font-family:var(--ds-font-family-code); font-size:11px; color:var(--dsw-alias-label-secondary); }

.dshtd-stepper { display:inline-flex; align-items:center; gap:6px; flex:0 0 auto; }
.dshtd-step { width:26px; height:26px; padding:0; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary); font-size:15px; line-height:24px; cursor:pointer; }
.dshtd-step:hover:not(:disabled) { border-color:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-state-business-primary); }
.dshtd-step:disabled { opacity:.4; cursor:default; }
.dshtd-stepValue { min-width:42px; text-align:center; font-family:var(--ds-font-family-code); font-size:12px; }

.dshtd-previewHead { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.dshtd-previewMeta { font-family:var(--ds-font-family-code); font-size:10px; color:var(--dsw-alias-label-secondary); }
.dshtd-preview { margin-top:8px; padding:2px 12px; border-radius:8px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); }
.dshtd-previewText { margin:10px 0; color:var(--dsw-alias-label-primary); }
`

    // ---- 状态与持久化 ----

    /** 把数值夹到闭区间；非有限值退回 fallback。 */
    function clamp(value, min, max, fallback) {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, number))
    }

    /** 行高按 0.01 归整，避免滑杆写出 1.5000000000000002；预设可以用 1.38 这类细档。 */
    function roundLineHeight(value) {
      return Math.round(value * 100) / 100
    }

    /** 清洗 localStorage 里的脏数据；只保留认识的字段与合法范围。 */
    function sanitizeState(raw) {
      const next = { ...DEFAULT_STATE }
      if (raw === null || typeof raw !== 'object') return next
      if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled
      next.lineHeight = roundLineHeight(
        clamp(raw.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_STATE.lineHeight),
      )
      next.flowGap = Math.round(clamp(raw.flowGap, FLOW_GAP_MIN, FLOW_GAP_MAX, DEFAULT_STATE.flowGap))
      if (SIDEBAR_MODES.includes(raw.sidebar)) next.sidebar = raw.sidebar
      return next
    }

    function loadState() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null || raw === '') return { ...DEFAULT_STATE }
        return sanitizeState(JSON.parse(raw))
      } catch {
        return { ...DEFAULT_STATE }
      }
    }

    let state = loadState()
    let workspaceColors = loadWorkspaceColors()
    /** workspaces 服务的 list 快照；服务未就绪时为 null。 */
    let workspaceStore = null
    let workspaceStyle = null
    let revision = 0
    const listeners = new Set()

    function saveState() {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      } catch {
        /* 存不下就只在本次进程内生效 */
      }
    }

    function emit() {
      revision += 1
      for (const listener of [...listeners]) {
        try {
          listener(revision)
        } catch {
          /* 单个订阅者出错不影响其它 */
        }
      }
    }

    function useStore() {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => {
          listeners.delete(force)
        }
      }, [])
      return state
    }

    // ---- 工作区配色 ----

    /** 只接受 #rgb / #rrggbb；其它值（含 localStorage 里被改坏的）一律丢弃。 */
    function normalizeHex(value) {
      if (typeof value !== 'string') return null
      const text = value.trim()
      if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase()
      if (/^#[0-9a-f]{3}$/i.test(text)) {
        const digits = text.slice(1).split('').map((digit) => digit + digit).join('')
        return `#${digits}`.toLowerCase()
      }
      return null
    }

    /** 清洗工作区配色存储；颜色只能是 hex，键只保留字符串。 */
    function sanitizeWorkspaceColors(raw) {
      const next = { enabled: true, colors: {} }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return next
      if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled
      if (raw.colors === null || typeof raw.colors !== 'object' || Array.isArray(raw.colors)) return next
      for (const [id, value] of Object.entries(raw.colors)) {
        // 避免把 JSON 里的 __proto__ 当成普通键写进对象原型。
        if (typeof id !== 'string' || id === '' || id === '__proto__') continue
        const color = normalizeHex(value)
        if (color !== null) next.colors[id] = color
      }
      return next
    }

    function loadWorkspaceColors() {
      try {
        const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
        if (raw === null || raw === '') return { enabled: true, colors: {} }
        return sanitizeWorkspaceColors(JSON.parse(raw))
      } catch {
        return { enabled: true, colors: {} }
      }
    }

    function saveWorkspaceColors() {
      try {
        window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaceColors))
      } catch {
        /* 存不下就只在本次进程内生效 */
      }
    }

    /** 读取 workspaces 服务的快照；服务未连接或结构异常时返回空数组。 */
    function readWorkspaces() {
      if (workspaceStore === null || typeof workspaceStore.getSnapshot !== 'function') return []
      try {
        const snapshot = workspaceStore.getSnapshot()
        const items = Array.isArray(snapshot?.items) ? snapshot.items : []
        return items.filter(
          (item) =>
            item !== null &&
            typeof item === 'object' &&
            typeof item.workspaceId === 'string' &&
            item.workspaceId !== '',
        )
      } catch {
        return []
      }
    }

    /** 按创建时间排序，让自动配色在列表增删时尽量稳定。 */
    function compareWorkspaces(left, right) {
      const leftTime = typeof left.createdAt === 'string' ? Date.parse(left.createdAt) : Number.NaN
      const rightTime = typeof right.createdAt === 'string' ? Date.parse(right.createdAt) : Number.NaN
      const leftRank = Number.isFinite(leftTime) ? leftTime : 0
      const rightRank = Number.isFinite(rightTime) ? rightTime : 0
      if (leftRank !== rightRank) return leftRank - rightRank
      return String(left.workspaceId).localeCompare(String(right.workspaceId))
    }

    /** FNV-1a；只用于把 workspaceId 稳定映射到色板，不需要密码学强度。 */
    function workspaceHash(value) {
      let hash = 2166136261
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
      return hash >>> 0
    }

    /**
     * 当前工作区与颜色。用户显式指定的颜色优先；其余按 ID 哈希取色，
     * 再线性探测避开“自动色”里已经用过的颜色，保证 10 个以内默认互不相同。
     *
     * 注意：这里不把用户自定义色加入自动色的去重集合。否则给 A 挑一个颜色，
     * B 的自动色可能因为碰撞被挤到下一个色板，用户会看到别的行莫名变色。
     * 手动改成同色是允许的，设置页会标成「自定义」。
     * 返回顺序保持 Host 的工作区顺序，设置页与侧栏看到的是同一顺序。
     */
    function workspaceEntries() {
      const items = readWorkspaces()
      const ordered = [...items].sort(compareWorkspaces)
      const used = new Set()
      const assigned = new Map()
      for (const item of ordered) {
        const override = workspaceColors.colors[item.workspaceId]
        if (override !== undefined) {
          assigned.set(item.workspaceId, override)
          continue
        }
        const start = workspaceHash(item.workspaceId) % WORKSPACE_PALETTE.length
        let color = WORKSPACE_PALETTE[start]
        for (let step = 0; step < WORKSPACE_PALETTE.length; step += 1) {
          const candidate = WORKSPACE_PALETTE[(start + step) % WORKSPACE_PALETTE.length]
          if (!used.has(candidate)) {
            color = candidate
            break
          }
        }
        used.add(color)
        assigned.set(item.workspaceId, color)
      }
      return items.map((item) => ({
        item,
        color: assigned.get(item.workspaceId) ?? WORKSPACE_PALETTE[0],
        custom: workspaceColors.colors[item.workspaceId] !== undefined,
      }))
    }

    function workspaceLabel(item) {
      const title = typeof item.title === 'string' ? item.title.trim() : ''
      if (title !== '') return title
      const path = typeof item.path === 'string' ? item.path : ''
      const parts = path.split(/[\\/]+/).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : t('workspaceUntitled')
    }

    /** 把 workspaceId 安全地放进 CSS 属性选择器的双引号字符串里。 */
    function escapeCssString(value) {
      return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')
    }

    /** 把 #rrggbb 转成带透明度的 rgba()，供整组底色使用。 */
    function hexToRgba(value, alpha) {
      const text = value.slice(1)
      const red = Number.parseInt(text.slice(0, 2), 16)
      const green = Number.parseInt(text.slice(2, 4), 16)
      const blue = Number.parseInt(text.slice(4, 6), 16)
      return `rgba(${red}, ${green}, ${blue}, ${alpha})`
    }

    /**
     * 生成工作区底色样式。
     *
     * 两层颜色：
     * - 整个 `_groupSection` 用 16% 的 rgba 铺底，会话列表透出浅色；
     * - 工作区目录行再用 `::before` 叠到 24%，形成“目录深、会话浅”的层次。
     *
     * 组背景直接写 background-color，不占用 `::before/::after`：官方拖动工作区时
     * 会用这两个伪元素画插入线，不能让配色抢掉。目录行仍用负 z-index 的伪元素，
     * 悬停、选中和菜单打开时的官方背景还能叠在下面。
     * 所有规则都要求祖先为 `[data-slot="sidebar"]`，主区、右侧栏不受影响。
     */
    function buildWorkspaceColorCss() {
      if (!workspaceColors.enabled) return ''
      const entries = workspaceEntries()
      if (entries.length === 0) return ''
      const rules = entries.map(({ item, color }) => {
        const id = escapeCssString(item.workspaceId)
        // 工作区行可能被 HoverCard 的 span 包一层；同时兼容没有 wrapper 的情况。
        // 只匹配“直接子节点或直接子节点的一层子节点”，避免父分组误命中嵌套工作区。
        const group = `[data-slot="sidebar"] div[class*="_groupSection"]:has(> [data-row-key="workspace:${id}"], > * > [data-row-key="workspace:${id}"])`
        const row = `[data-slot="sidebar"] [data-row-key="workspace:${id}"]`
        return `${group} {
  background-color: ${hexToRgba(color, 0.16)};
  border-radius: 8px;
}
${row} {
  position: relative;
  isolation: isolate;
}
${row}::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: ${color};
  opacity: 0.24;
  pointer-events: none;
  z-index: -1;
}`
      }).join('\n')
      return `/* 工作区底色：整组浅色 + 目录行深色；颜色由“工作区配色”设置写入。 */\n${rules}
[data-slot="sidebar"] [data-row-key^="workspace:"]:hover::before { opacity: 0.18; }
`
    }

    function removeWorkspaceStyle() {
      if (workspaceStyle === null) return
      const style = workspaceStyle
      workspaceStyle = null
      try {
        style.remove()
      } catch {
        /* 已经随页面卸载的节点忽略 */
      }
    }

    function applyWorkspaceStyle() {
      if (typeof document === 'undefined') return
      const css = buildWorkspaceColorCss()
      if (css === '') {
        removeWorkspaceStyle()
        return
      }
      if (workspaceStyle === null) {
        // HMR 重载时复用上一实例留下的节点，避免 head 里堆多份同样的样式。
        const existing = typeof document.querySelector === 'function'
          ? document.querySelector('style[data-dsh-density="workspace-colors"]')
          : null
        if (existing !== null && existing !== undefined) {
          workspaceStyle = existing
        } else {
          const style = document.createElement('style')
          style.dataset.dshDensity = 'workspace-colors'
          document.head.appendChild(style)
          workspaceStyle = style
        }
      }
      if (workspaceStyle.textContent !== css) workspaceStyle.textContent = css
    }

    function commitWorkspaceColors() {
      saveWorkspaceColors()
      applyWorkspaceStyle()
      emit()
    }

    function setWorkspaceColorsEnabled(next) {
      workspaceColors = { ...workspaceColors, enabled: next === true }
      commitWorkspaceColors()
    }

    function setWorkspaceColor(workspaceId, value) {
      const color = normalizeHex(value)
      if (typeof workspaceId !== 'string' || workspaceId === '' || color === null) return
      workspaceColors = {
        ...workspaceColors,
        enabled: true,
        colors: { ...workspaceColors.colors, [workspaceId]: color },
      }
      commitWorkspaceColors()
    }

    function resetWorkspaceColor(workspaceId) {
      if (!Object.prototype.hasOwnProperty.call(workspaceColors.colors, workspaceId)) return
      const colors = { ...workspaceColors.colors }
      delete colors[workspaceId]
      workspaceColors = { ...workspaceColors, colors }
      commitWorkspaceColors()
    }

    function resetAllWorkspaceColors() {
      workspaceColors = { ...workspaceColors, colors: {} }
      commitWorkspaceColors()
    }

    /** 当前预设：关闭覆盖层算官方；数值命中预设算预设，否则算自定义。 */
    function presetId(current) {
      if (!current.enabled) return 'official'
      for (const preset of PRESETS) {
        if (!preset.enabled) continue
        if (
          Math.abs(preset.lineHeight - current.lineHeight) < 0.001 &&
          preset.flowGap === current.flowGap
        ) {
          return preset.id
        }
      }
      return 'custom'
    }

    // ---- token 覆盖 ----

    /** 主题层的每个 token 都要两侧成对，排版值两侧相同。 */
    function pair(value) {
      return { light: value, dark: value }
    }

    /**
     * 构造覆盖层。
     *
     * 值里引用 `--dsh-content-font-size` / `--dsh-content-font-size-secondary`，
     * 所以用户在官方设置里改字号时，行高倍数不用重算，主题快照自己会更新。
     * `font` 简写接受无单位行高，`calc(... * 倍数)` 则给单独消费 `-line-height`
     * token 的组件使用。
     * @param lineHeight - 行高倍数（1.25–1.8）。
     * @param flowGap - 消息间距，单位 px。
     * @returns token 名到 `{ light, dark }` 的映射。
     */
    function buildTokens(lineHeight, flowGap) {
      const ratio = String(roundLineHeight(lineHeight))
      const family = 'var(--dsw-font-family)'
      const text = 'var(--dsh-content-font-size, 14px)'
      const secondary = 'var(--dsh-content-font-size-secondary, 13px)'
      const textLine = `calc(${text} * ${ratio})`
      const secondaryLine = `calc(${secondary} * ${ratio})`
      return {
        '--dsh-chat-flow-gap': pair(`${flowGap}px`),
        '--dsw-font-markdown-base': pair(`${text} / ${ratio} ${family}`),
        '--dsw-font-markdown-base-line-height': pair(textLine),
        '--dsw-font-markdown-base-strong': pair(`600 ${text} / ${ratio} ${family}`),
        '--dsw-font-markdown-base-strong-line-height': pair(textLine),
        '--dsw-font-markdown-base-italic': pair(`italic ${text} / ${ratio} ${family}`),
        '--dsw-font-markdown-base-italic-line-height': pair(textLine),
        '--dsw-font-markdown-base-strong-italic': pair(`italic 600 ${text} / ${ratio} ${family}`),
        '--dsw-font-markdown-base-strong-italic-line-height': pair(textLine),
        '--dsw-font-markdown-h4': pair(`600 ${text} / ${ratio} ${family}`),
        '--dsw-font-markdown-h4-line-height': pair(textLine),
        '--dsw-font-markdown-table': pair(`${secondary} / ${ratio} ${family}`),
        '--dsw-font-markdown-table-line-height': pair(secondaryLine),
        '--dsw-font-markdown-table-head': pair(`500 ${secondary} / ${ratio} ${family}`),
        '--dsw-font-markdown-table-head-line-height': pair(secondaryLine),
      }
    }

    function warn(message, error) {
      try {
        console.warn(`[density] ${message}`, error)
      } catch {
        /* 忽略 */
      }
    }

    function disposeCurrentLayer() {
      if (disposeLayer === null) return
      const dispose = disposeLayer
      disposeLayer = null
      try {
        dispose()
      } catch {
        /* 已经随上下文销毁的层忽略 */
      }
    }

    function applyOverrides() {
      disposeCurrentLayer()
      if (theme === null || typeof theme.overrideTokens !== 'function') return
      if (!state.enabled) return
      try {
        disposeLayer = theme.overrideTokens(SOURCE, buildTokens(state.lineHeight, state.flowGap))
      } catch (error) {
        disposeLayer = null
        warn('覆盖排版 token 失败：', error)
      }
    }

    /**
     * 生成侧栏样式。
     *
     * 侧栏的行高/字号没有官方 token，只能覆盖 CSS；选择器优先用
     * `data-slot="sidebar"`、`data-row-key^="session:"` 这类稳定属性，
     * 类名只取 `_logoRow` / `_panelRow` 这样的局部名，避免依赖构建哈希。
     * 全部规则都限定在左侧栏内，主区与右侧栏不受影响。
     * @param mode - `compact` / `dense`；其它值返回空串。
     * @returns 注入到 document.head 的 CSS 文本。
     */
    function buildSidebarCss(mode) {
      if (mode !== 'compact' && mode !== 'dense') return ''
      const dense = mode === 'dense'
      const row = dense ? 22 : 24
      const project = dense ? 24 : 26
      const nav = dense ? 26 : 28
      const newSession = dense ? 28 : 30
      const logo = dense ? 36 : 38
      const overflow = dense ? 20 : 22
      const footer = dense ? 34 : 36
      const title = dense ? 12 : 12.5
      const titleLine = dense ? 16 : 17
      const navSize = dense ? 12.5 : 13
      const navLine = dense ? 17 : 18
      const rootPad = dense ? 2 : 3
      const rowIcon = dense ? 20 : 24
      // 所有规则都挂在“展开态的侧栏根”下：折叠成 36px 窄条时一条都不生效，
      // 顶部 topStrip（macOS 交通灯）也不吃根内边距。
      const scope = '[data-slot="sidebar"] > *:not([class*="_collapsed"]):not([class*="_topStrip"])'
      return `
/* 侧栏密度（${mode}）：只作用于左侧栏；优先用 data-slot / data-row-key，类名只取局部名。 */
${scope} {
  --dsh-sidebar-inline-padding: 6px !important;
  --dsh-sidebar-row-padding: 8px !important;
  --dsh-sidebar-label-gap: 4px !important;
  --dsh-sidebar-paint-inset: 2px !important;
  padding-top: ${rootPad}px !important;
  padding-bottom: ${rootPad}px !important;
  font-size: 13px;
}
${scope} div[class*="_logoRow"] {
  height: ${logo}px !important;
  padding-top: 4px !important;
  padding-bottom: 4px !important;
}
${scope} span[class*="_brandName"] {
  font-size: 15px !important;
  line-height: 20px !important;
}
${scope} button[class*="_newSession"] {
  height: ${newSession}px !important;
  margin-bottom: 6px !important;
  padding: 4px 10px !important;
  font-size: 13px !important;
  line-height: 18px !important;
}
${scope} [class*="_panelList"] {
  gap: 1px !important;
  margin-bottom: 4px !important;
}
${scope} button[class*="_panelRow"] {
  min-height: ${nav}px !important;
  padding-top: 3px !important;
  padding-bottom: 3px !important;
  font-size: ${navSize}px !important;
  line-height: ${navLine}px !important;
}
${scope} div[class*="_sectionHeader"] {
  height: 28px !important;
  margin-top: 0 !important;
  margin-bottom: 2px !important;
}
${scope} span[class*="_sectionLabel"] {
  font-size: 12px !important;
  line-height: 16px !important;
}
${scope} [role="tree"] {
  padding-bottom: 6px !important;
}
${scope} div[class*="_groupSection"] + div[class*="_groupSection"] {
  margin-top: 2px !important;
}
${scope} div[class*="_groupSection"] > * + * {
  margin-top: 1px !important;
}
${scope} [data-row-key^="workspace:"] {
  height: ${project}px !important;
  min-height: 0 !important;
}
${scope} [data-row-key^="session:"] {
  height: ${row}px !important;
  min-height: 0 !important;
}
${scope} [data-row-key] > [class*="_title"],
${scope} [data-row-key] [class*="_projectText"] > [class*="_title"] {
  font-size: ${title}px !important;
  line-height: ${titleLine}px !important;
}
${scope} [data-row-key] > [class*="_time"] {
  font-size: 10px !important;
  line-height: 14px !important;
}
${scope} [data-row-key] [class*="_projectText"] [class*="_meta"] {
  font-size: 11px !important;
  line-height: 15px !important;
}
${scope} [data-row-key] button[class*="_iconButton"] {
  width: ${rowIcon}px !important;
  height: ${rowIcon}px !important;
}
${scope} button[class*="_sessionOverflowButton"] {
  height: ${overflow}px !important;
  font-size: 11px !important;
  line-height: 16px !important;
}
${scope} [class*="_footArea"] button[class*="_trigger"] {
  height: ${footer}px !important;
  font-size: 12.5px !important;
  line-height: 18px !important;
}
`
    }

    let sidebarStyle = null

    function removeSidebarStyle() {
      if (sidebarStyle === null) return
      const style = sidebarStyle
      sidebarStyle = null
      try {
        style.remove()
      } catch {
        /* 已经随页面卸载的节点忽略 */
      }
    }

    function applySidebarStyle() {
      if (typeof document === 'undefined') return
      const css = buildSidebarCss(state.sidebar)
      if (css === '') {
        removeSidebarStyle()
        return
      }
      if (sidebarStyle === null) {
        // HMR 重载时复用上一实例留下的节点，避免 head 里堆多份同样的样式。
        const existing = typeof document.querySelector === 'function'
          ? document.querySelector('style[data-dsh-density="sidebar"]')
          : null
        if (existing !== null && existing !== undefined) {
          sidebarStyle = existing
        } else {
          const style = document.createElement('style')
          style.dataset.dshDensity = 'sidebar'
          document.head.appendChild(style)
          sidebarStyle = style
        }
      }
      if (sidebarStyle.textContent !== css) sidebarStyle.textContent = css
    }

    function commit() {
      applyOverrides()
      applySidebarStyle()
      saveState()
      emit()
    }

    function setEnabled(next) {
      state = { ...state, enabled: next === true }
      commit()
    }

    function setLineHeight(value) {
      const lineHeight = roundLineHeight(clamp(value, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, state.lineHeight))
      state = { ...state, enabled: true, lineHeight }
      commit()
    }

    function setFlowGap(value) {
      const flowGap = Math.round(clamp(value, FLOW_GAP_MIN, FLOW_GAP_MAX, state.flowGap))
      state = { ...state, enabled: true, flowGap }
      commit()
    }

    function applyPreset(preset) {
      state = {
        ...state,
        enabled: preset.enabled,
        lineHeight: preset.lineHeight,
        flowGap: preset.flowGap,
      }
      commit()
    }

    function setSidebar(mode) {
      if (!SIDEBAR_MODES.includes(mode)) return
      state = { ...state, sidebar: mode }
      commit()
    }

    function resetAll() {
      state = { ...DEFAULT_STATE }
      commit()
    }

    // ---- 与官方字号设置互通 ----

    /** 从主题快照读当前字号；服务未就绪时退回官方默认值。 */
    function currentFontSize(role) {
      if (theme !== null && typeof theme.getTheme === 'function') {
        try {
          const value = theme.getTheme()?.fontSizes?.[role]
          if (Number.isFinite(value)) return value
        } catch {
          /* 快照读不到就继续往下退 */
        }
      }
      return FONT_DEFAULTS[role]
    }

    /**
     * 步进官方字号。写的是 ui-theme 的持久化设置，所以「通用」里的步进器、
     * Ctrl/Cmd + - 与本面板看到的是同一个值。
     * @param role - `text` 或 `code`。
     * @param delta - +1 / -1。
     */
    function stepFontSize(role, delta) {
      if (theme === null || typeof theme.setFontSize !== 'function') return
      const range = FONT_RANGES[role]
      if (range === undefined) return
      const [min, max] = range
      const next = Math.min(max, Math.max(min, currentFontSize(role) + delta))
      try {
        theme.setFontSize(role, next)
      } catch (error) {
        warn('调整字号失败：', error)
      }
    }

    // ---- 组件 ----

    function PresetButton({ preset, active }) {
      return h(
        'button',
        {
          className: active ? 'dshtd-preset is-on' : 'dshtd-preset',
          type: 'button',
          'data-preset': preset.id,
          'aria-pressed': active ? 'true' : 'false',
          onClick: () => applyPreset(preset),
        },
        h('span', { className: 'dshtd-presetName' }, t(preset.nameKey)),
        h('span', { className: 'dshtd-presetNote' }, t(preset.noteKey)),
      )
    }

    function SidebarPreset({ preset, active }) {
      return h(
        'button',
        {
          className: active ? 'dshtd-preset is-on' : 'dshtd-preset',
          type: 'button',
          'data-sidebar': preset.id,
          'aria-pressed': active ? 'true' : 'false',
          onClick: () => setSidebar(preset.id),
        },
        h('span', { className: 'dshtd-presetName' }, t(preset.nameKey)),
        h('span', { className: 'dshtd-presetNote' }, t(preset.noteKey)),
      )
    }

    function SliderRow({ setting, labelKey, descKey, min, max, step, value, format, onChange }) {
      return h(
        'div',
        { className: 'dshtd-row' },
        h(
          'div',
          { className: 'dshtd-rowText' },
          h('div', { className: 'dshtd-rowLabel' }, t(labelKey)),
          h('div', { className: 'dshtd-rowDesc' }, t(descKey)),
        ),
        h(
          'div',
          { className: 'dshtd-sliderControl' },
          h('input', {
            className: 'dshtd-range',
            type: 'range',
            min,
            max,
            step,
            value,
            'data-setting': setting,
            'aria-label': t(labelKey),
            onChange: (event) => onChange(event.target.value),
          }),
          h('span', { className: 'dshtd-sliderValue' }, format(value)),
        ),
      )
    }

    function FontStepper({ role }) {
      useStore()
      const value = currentFontSize(role)
      const [min, max] = FONT_RANGES[role]
      const label = t(role === 'text' ? 'fontSizeText' : 'fontSizeCode')
      return h(
        'div',
        { className: 'dshtd-stepper' },
        h(
          'button',
          {
            className: 'dshtd-step',
            type: 'button',
            'data-action': `${role}-decrease`,
            'aria-label': `${t('decrease')} ${label}`,
            disabled: value <= min,
            onClick: () => stepFontSize(role, -1),
          },
          '−',
        ),
        h('span', { className: 'dshtd-stepValue', 'data-role': `${role}-value` }, `${value}px`),
        h(
          'button',
          {
            className: 'dshtd-step',
            type: 'button',
            'data-action': `${role}-increase`,
            'aria-label': `${t('increase')} ${label}`,
            disabled: value >= max,
            onClick: () => stepFontSize(role, 1),
          },
          '+',
        ),
      )
    }

    function FontRow({ role, labelKey, descKey }) {
      return h(
        'div',
        { className: 'dshtd-row' },
        h(
          'div',
          { className: 'dshtd-rowText' },
          h('div', { className: 'dshtd-rowLabel' }, t(labelKey)),
          h('div', { className: 'dshtd-rowDesc' }, t(descKey)),
        ),
        h(FontStepper, { role }),
      )
    }

    function WorkspaceColorRow({ entry }) {
      const label = workspaceLabel(entry.item)
      const path = typeof entry.item.path === 'string' ? entry.item.path : ''
      return h(
        'div',
        { className: 'dshtd-colorRow', 'data-workspace-id': entry.item.workspaceId },
        h('input', {
          className: 'dshtd-colorInput',
          type: 'color',
          value: entry.color,
          'data-workspace-color': entry.item.workspaceId,
          'aria-label': `${t('workspaceColorLabel')} ${label}`,
          onChange: (event) => setWorkspaceColor(entry.item.workspaceId, event.target.value),
        }),
        h(
          'div',
          { className: 'dshtd-colorText' },
          h('div', { className: 'dshtd-colorName', title: label }, label),
          path === ''
            ? h('div', { className: 'dshtd-colorPath' }, t('workspaceNoPath'))
            : h('div', { className: 'dshtd-colorPath', title: path }, path),
          h(
            'div',
            { className: 'dshtd-colorMeta' },
            h(
              'span',
              { className: 'dshtd-colorTag' },
              entry.custom ? t('workspaceCustom') : t('workspaceAuto'),
            ),
          ),
        ),
        entry.custom
          ? h(
              'button',
              {
                className: 'dshtd-btn dshtd-colorAction',
                type: 'button',
                'data-workspace-auto': entry.item.workspaceId,
                onClick: () => resetWorkspaceColor(entry.item.workspaceId),
              },
              t('workspaceUseAuto'),
            )
          : null,
      )
    }

    function WorkspaceColorsSection() {
      // 只借 useStore 订阅 emit；工作区列表变化和颜色修改都会走同一个 revision。
      useStore()
      const entries = workspaceEntries()
      const hasCustom = entries.some((entry) => entry.custom)
      return h(
        'div',
        { className: 'dshtd-root' },
        h('style', { key: 'style' }, CSS),
        h(
          'div',
          { className: 'dshtd-head', key: 'head' },
          h('h3', { className: 'dshtd-title' }, t('workspaceTitle')),
          h('span', { className: 'dshtd-badge' }, String(entries.length)),
          h('span', { className: 'dshtd-spacer' }),
          h(
            'button',
            {
              className: 'dshtd-btn',
              type: 'button',
              'data-action': 'workspace-auto-all',
              disabled: !hasCustom,
              onClick: resetAllWorkspaceColors,
            },
            t('workspaceAutoAll'),
          ),
        ),
        h('p', { className: 'dshtd-desc', key: 'intro' }, t('workspaceIntro')),
        workspaceStore === null
          ? h('p', { className: 'dshtd-warn', key: 'warn' }, t('workspaceServiceMissing'))
          : null,
        h(
          'div',
          { className: 'dshtd-card', key: 'card' },
          h(
            'label',
            { className: 'dshtd-switch' },
            h('input', {
              type: 'checkbox',
              'data-setting': 'workspace-colors-enabled',
              checked: workspaceColors.enabled,
              onChange: (event) => setWorkspaceColorsEnabled(event.target.checked),
            }),
            h('span', null, t('workspaceEnabled')),
          ),
          h('div', { className: 'dshtd-hint' }, t('workspaceEnabledHint')),
          entries.length === 0
            ? h('div', { className: 'dshtd-colorEmpty', key: 'empty' }, t('workspaceEmpty'))
            : h(
                'div',
                { className: 'dshtd-colorList', key: 'list' },
                entries.map((entry) =>
                  h(WorkspaceColorRow, { key: entry.item.workspaceId, entry }),
                ),
              ),
          h('div', { className: 'dshtd-hint' }, t('workspaceHint')),
        ),
        h('div', { className: 'dshtd-foot', key: 'foot' }, t('storageHint')),
      )
    }

    function DensitySection() {
      const current = useStore()
      const active = presetId(current)
      const textSize = currentFontSize('text')
      // 关闭覆盖层时预览官方公式：24px + (字号 - 14) = 字号 + 10。
      const effectiveLineHeight = current.enabled
        ? current.lineHeight
        : (textSize + 10) / textSize
      const previewStyle = {
        fontSize: `${textSize}px`,
        lineHeight: String(effectiveLineHeight),
      }
      return h(
        'div',
        { className: 'dshtd-root' },
        h('style', { key: 'style' }, CSS),
        h(
          'div',
          { className: 'dshtd-head', key: 'head' },
          h('h3', { className: 'dshtd-title' }, t('title')),
          h(
            'span',
            { className: 'dshtd-badge' },
            current.enabled ? `${current.lineHeight.toFixed(2)}×` : t('pOfficial'),
          ),
          h('span', { className: 'dshtd-spacer' }),
          h('button', { className: 'dshtd-btn', type: 'button', onClick: resetAll }, t('resetAll')),
        ),
        h('p', { className: 'dshtd-desc', key: 'intro' }, t('intro')),
        theme === null ? h('p', { className: 'dshtd-warn', key: 'warn' }, t('noTheme')) : null,
        h(
          'div',
          { className: 'dshtd-card', key: 'presets' },
          h(
            'label',
            { className: 'dshtd-switch' },
            h('input', {
              type: 'checkbox',
              checked: current.enabled,
              onChange: (event) => setEnabled(event.target.checked),
            }),
            h('span', null, t('enabled')),
          ),
          h('div', { className: 'dshtd-hint' }, t('enableHint')),
          h(
            'div',
            { className: 'dshtd-presets' },
            PRESETS.map((preset) =>
              h(PresetButton, { key: preset.id, preset, active: active === preset.id }),
            ),
          ),
          h(SliderRow, {
            setting: 'lineHeight',
            labelKey: 'lineHeight',
            descKey: 'lineHeightDesc',
            min: LINE_HEIGHT_MIN,
            max: LINE_HEIGHT_MAX,
            step: LINE_HEIGHT_STEP,
            value: current.lineHeight,
            format: (value) => `${Number(value).toFixed(2)}×`,
            onChange: setLineHeight,
          }),
          h(SliderRow, {
            setting: 'flowGap',
            labelKey: 'flowGap',
            descKey: 'flowGapDesc',
            min: FLOW_GAP_MIN,
            max: FLOW_GAP_MAX,
            step: 1,
            value: current.flowGap,
            format: (value) => `${value}px`,
            onChange: setFlowGap,
          }),
          h('div', { className: 'dshtd-hint' }, t('scopeHint')),
        ),
        h(
          'div',
          { className: 'dshtd-card', key: 'sidebar' },
          h('h4', { className: 'dshtd-cardTitle' }, t('sidebarTitle')),
          h('p', { className: 'dshtd-hint' }, t('sidebarDesc')),
          h(
            'div',
            { className: 'dshtd-presets' },
            SIDEBAR_PRESETS.map((preset) =>
              h(SidebarPreset, {
                key: preset.id,
                preset,
                active: current.sidebar === preset.id,
              }),
            ),
          ),
          h('div', { className: 'dshtd-hint' }, t('sidebarHint')),
        ),
        h(
          'div',
          { className: 'dshtd-card', key: 'fonts' },
          h('h4', { className: 'dshtd-cardTitle' }, t('fontTitle')),
          h(FontRow, {
            role: 'text',
            labelKey: 'fontSizeText',
            descKey: 'fontSizeTextDesc',
          }),
          h(FontRow, {
            role: 'code',
            labelKey: 'fontSizeCode',
            descKey: 'fontSizeCodeDesc',
          }),
          h('div', { className: 'dshtd-hint' }, t('fontSizeHint')),
        ),
        h(
          'div',
          { className: 'dshtd-card', key: 'preview' },
          h(
            'div',
            { className: 'dshtd-previewHead' },
            h('h4', { className: 'dshtd-cardTitle' }, t('preview')),
            h(
              'span',
              { className: 'dshtd-previewMeta' },
              `${textSize}px · ${effectiveLineHeight.toFixed(2)}×`,
            ),
          ),
          h(
            'div',
            { className: 'dshtd-preview' },
            h('p', { className: 'dshtd-previewText', style: previewStyle }, t('previewP1')),
            h('p', { className: 'dshtd-previewText', style: previewStyle }, t('previewP2')),
          ),
        ),
        h('div', { className: 'dshtd-foot', key: 'foot' }, t('storageHint')),
      )
    }

    function apply(ctx) {
      t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'density: dictionaries')

      theme = ctx.theme ?? null
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('workspaces') : null
        workspaceStore = service?.list ?? null
      } catch {
        workspaceStore = null
      }
      if (workspaceStore !== null && typeof workspaceStore.subscribe === 'function') {
        ctx.effect(
          () =>
            workspaceStore.subscribe(() => {
              applyWorkspaceStyle()
              emit()
            }),
          'density: workspace colors follow list',
        )
      }

      // 早于设置页渲染先应用一次；页面一打开就是用户上次选的密度与配色。
      applyOverrides()
      applySidebarStyle()
      applyWorkspaceStyle()

      // 官方字号变化（含 Ctrl/Cmd + -）会广播 theme/change，面板跟着刷新读数。
      ctx.effect(
        () => ctx.on('theme/change', () => emit()),
        'density: follow font-size changes',
      )

      ctx.effect(
        () => () => {
          if (disposeLayer === null) return
          const dispose = disposeLayer
          disposeLayer = null
          try {
            dispose()
          } catch {
            /* 插件卸载时层已随上下文销毁则忽略 */
          }
        },
        'density: token override layer',
      )

      ctx.effect(() => () => removeSidebarStyle(), 'density: sidebar stylesheet')
      ctx.effect(() => () => removeWorkspaceStyle(), 'density: workspace colors')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'density',
            order: 6,
            label: () => t('nav'),
            locale: NS,
          },
          DensitySection,
        ),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'workspace-colors',
            order: 7,
            label: () => t('workspaceNav'),
            locale: NS,
          },
          WorkspaceColorsSection,
        ),
      )
    }

    return { inject: ['slots', 'locale', 'theme', 'workspaces'], apply }
  },
})
