/**
 * 外观颜色 —— Client 半。
 *
 * 在设置面板里注册一个 `settings.section` 页面：用取色器自由调整深色模式的
 * 关键配色 token（主背景 / 侧栏 / 卡片 / 文字 / 强调色 / 分隔线）。
 *
 * 生效方式：调用官方主题服务 `ctx.theme.overrideTokens(source, tokens)`
 * ——这是 ui-theme 提供的公开扩展点（第三方主题用别名 token 覆盖），
 * ui-layout 会把快照里的 token 直接 setProperty 到 body 上，
 * 所以改动是立即生效的，不需要重启。
 *
 * 持久化：localStorage。DSH Desktop 固定监听 127.0.0.1:19387，
 * origin 稳定，因此跨重启有效；localStorage 不可用时退化为进程内。
 *
 * 浅色模式不受影响：只覆盖 dark 一侧，light 一侧固定传官方原值。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-theme-colors',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'theme-colors'
    /** token 覆盖层的来源标识（同一来源重复覆盖会替换整层）。 */
    const SOURCE = 'dsh-theme-colors'
    const STORAGE_KEY = 'dsh-theme-colors/v1'

    /**
     * 关键 token 目录。
     * - `dark`  官方深色原值（也是“重置”的目标值）
     * - `light` 官方浅色原值，覆盖层里原样带过去，浅色模式保持官方配色
     */
    const GROUPS = [
      {
        id: 'surface',
        title: '背景与表面',
        items: [
          { token: '--dsw-alias-bg-base', label: '主背景', desc: '整个应用的底层画布', dark: '#151517', light: '#ffffff' },
          { token: '--dsw-specific-sidebar-fill', label: '侧边栏', desc: '左侧栏与窗口标题栏底色', dark: '#1b1b1c', light: '#f9fafb' },
          { token: '--dsw-alias-bg-layer-1', label: '一级表面', desc: '从画布浮起的第一层容器', dark: '#232324', light: '#ffffff' },
          { token: '--dsw-alias-bg-layer-2', label: '二级表面', desc: '卡片、模块与嵌套容器', dark: '#2c2c2e', light: '#ffffff' },
          { token: '--dsw-alias-bg-overlay', label: '浮层底色', desc: '弹窗、下拉与浮出面板', dark: '#43454a', light: '#e9ecf2' },
        ],
      },
      {
        id: 'text',
        title: '文字',
        items: [
          { token: '--dsw-alias-label-primary', label: '正文', desc: '主要文本与标题', dark: '#f9fafb', light: '#0f1115' },
          { token: '--dsw-alias-label-secondary', label: '次要文字', desc: '说明、时间戳与辅助信息', dark: '#cfd3d6', light: '#61666b' },
        ],
      },
      {
        id: 'accent',
        title: '强调色',
        items: [
          { token: '--dsw-alias-brand-primary', label: '品牌强调', desc: '主按钮填充、选中态与品牌标识', dark: '#f9fafb', light: '#0f1115' },
          { token: '--dsw-alias-state-business-primary', label: '链接与焦点', desc: '链接文字、焦点环与业务高亮', dark: '#7aaaff', light: '#4176e6' },
        ],
      },
      {
        id: 'line',
        title: '分隔线',
        items: [
          { token: '--dsw-alias-border-l1', label: '细边框', desc: '列表与卡片的分隔线，可用 8 位十六进制带透明度', dark: '#ffffff0f', light: '#0000000a' },
          { token: '--dsw-alias-border-l2', label: '粗边框', desc: '对比更强的描边，可用 8 位十六进制带透明度', dark: '#ffffff1f', light: '#0000001a' },
        ],
      },
    ]

    const ITEMS = GROUPS.reduce((all, group) => all.concat(group.items), [])
    const BY_TOKEN = new Map(ITEMS.map((item) => [item.token, item]))

    /**
     * 预设配色。只给深色一侧（浅色模式继续用官方原值），每套都覆盖全部 11 个 token，
     * 所以点一下就是完整一套、不会残留上一套的颜色。
     *
     * 全部按 WCAG 相对亮度体检过（断言在 smoke.mjs 里）：
     *   正文/底 7.4–11.4、次要文字/底 ≥ 4.7、链接/底 5.2–7.8、正文/卡片 ≥ 5.6、
     *   品牌色/按钮反色字 ≥ 10.9 —— 既不刺眼，也不至于看不清。
     * 前两套自研，其余取自公认的低对比护眼配色。
     */
    const PRESETS = [
      {
        id: 'warm-gray',
        name: '暖灰护眼',
        note: '自研 · 中性偏暖、零蓝光刺激，深夜最耐看',
        tokens: {
          '--dsw-alias-bg-base': '#1e1c1a',
          '--dsw-specific-sidebar-fill': '#252220',
          '--dsw-alias-bg-layer-1': '#2b2825',
          '--dsw-alias-bg-layer-2': '#35312d',
          '--dsw-alias-bg-overlay': '#423d37',
          '--dsw-alias-label-primary': '#d2cbc1',
          '--dsw-alias-label-secondary': '#a49b8e',
          '--dsw-alias-brand-primary': '#e7e0d5',
          '--dsw-alias-state-business-primary': '#c09a6b',
          '--dsw-alias-border-l1': '#ffffff12',
          '--dsw-alias-border-l2': '#ffffff22',
        },
      },
      {
        id: 'night-navy',
        name: '深蓝夜',
        note: '自研 · 低饱和深夜蓝，正文不刺白',
        tokens: {
          '--dsw-alias-bg-base': '#131820',
          '--dsw-specific-sidebar-fill': '#171d26',
          '--dsw-alias-bg-layer-1': '#1c232e',
          '--dsw-alias-bg-layer-2': '#232b38',
          '--dsw-alias-bg-overlay': '#2d3745',
          '--dsw-alias-label-primary': '#c6d0dc',
          '--dsw-alias-label-secondary': '#93a1b3',
          '--dsw-alias-brand-primary': '#dbe3ec',
          '--dsw-alias-state-business-primary': '#79a8cc',
          '--dsw-alias-border-l1': '#ffffff12',
          '--dsw-alias-border-l2': '#ffffff20',
        },
      },
      {
        id: 'everforest',
        name: '常青 Everforest',
        note: '低对比绿灰，公认久看不累',
        tokens: {
          '--dsw-alias-bg-base': '#2d353b',
          '--dsw-specific-sidebar-fill': '#232a2e',
          '--dsw-alias-bg-layer-1': '#343f44',
          '--dsw-alias-bg-layer-2': '#3d484d',
          '--dsw-alias-bg-overlay': '#475258',
          '--dsw-alias-label-primary': '#d3c6aa',
          '--dsw-alias-label-secondary': '#9da9a0',
          '--dsw-alias-brand-primary': '#e6dfc9',
          '--dsw-alias-state-business-primary': '#7fbbb3',
          '--dsw-alias-border-l1': '#ffffff14',
          '--dsw-alias-border-l2': '#ffffff24',
        },
      },
      {
        id: 'gruvbox',
        name: '格鲁布 Gruvbox',
        note: '暖色低对比经典，纸质暖调',
        tokens: {
          '--dsw-alias-bg-base': '#2b2927',
          '--dsw-specific-sidebar-fill': '#232120',
          '--dsw-alias-bg-layer-1': '#3c3836',
          '--dsw-alias-bg-layer-2': '#504945',
          '--dsw-alias-bg-overlay': '#665c54',
          '--dsw-alias-label-primary': '#ebdbb2',
          '--dsw-alias-label-secondary': '#bdae93',
          '--dsw-alias-brand-primary': '#f0e4c0',
          '--dsw-alias-state-business-primary': '#83a598',
          '--dsw-alias-border-l1': '#ffffff14',
          '--dsw-alias-border-l2': '#ffffff24',
        },
      },
      {
        id: 'nord',
        name: '北境 Nord',
        note: '冷灰蓝，极简低饱和',
        tokens: {
          '--dsw-alias-bg-base': '#2e3440',
          '--dsw-specific-sidebar-fill': '#292e39',
          '--dsw-alias-bg-layer-1': '#3b4252',
          '--dsw-alias-bg-layer-2': '#434c5e',
          '--dsw-alias-bg-overlay': '#4c566a',
          '--dsw-alias-label-primary': '#d8dee9',
          '--dsw-alias-label-secondary': '#9aa5b5',
          '--dsw-alias-brand-primary': '#e5e9f0',
          '--dsw-alias-state-business-primary': '#88c0d0',
          '--dsw-alias-border-l1': '#ffffff16',
          '--dsw-alias-border-l2': '#ffffff26',
        },
      },
      {
        id: 'solarized',
        name: '日光 Solarized',
        note: '经典青灰底，刻意压低对比',
        tokens: {
          '--dsw-alias-bg-base': '#002b36',
          '--dsw-specific-sidebar-fill': '#00252e',
          '--dsw-alias-bg-layer-1': '#073642',
          '--dsw-alias-bg-layer-2': '#0b4150',
          '--dsw-alias-bg-overlay': '#12495a',
          '--dsw-alias-label-primary': '#b0bfbf',
          '--dsw-alias-label-secondary': '#839496',
          '--dsw-alias-brand-primary': '#eee8d5',
          '--dsw-alias-state-business-primary': '#3f9fe0',
          '--dsw-alias-border-l1': '#ffffff12',
          '--dsw-alias-border-l2': '#ffffff20',
        },
      },
      {
        id: 'catppuccin',
        name: '摩卡 Catppuccin',
        note: '柔和粉紫，柔光感',
        tokens: {
          '--dsw-alias-bg-base': '#1e1e2e',
          '--dsw-specific-sidebar-fill': '#181825',
          '--dsw-alias-bg-layer-1': '#313244',
          '--dsw-alias-bg-layer-2': '#45475a',
          '--dsw-alias-bg-overlay': '#585b70',
          '--dsw-alias-label-primary': '#c6cfe8',
          '--dsw-alias-label-secondary': '#a6adc8',
          '--dsw-alias-brand-primary': '#dfe3f5',
          '--dsw-alias-state-business-primary': '#89b4fa',
          '--dsw-alias-border-l1': '#ffffff14',
          '--dsw-alias-border-l2': '#ffffff22',
        },
      },
    ]

    /** 预设与当前配色完全一致时，卡片高亮。 */
    function signatureOf(tokens) {
      return Object.keys(tokens)
        .sort()
        .map((token) => `${token}=${String(tokens[token]).toLowerCase()}`)
        .join('|')
    }

    const PRESET_SIGNATURES = new Map(PRESETS.map((preset) => [preset.id, signatureOf(preset.tokens)]))

    /** 允许写回的 CSS 颜色形式（其余一律拒绝，避免把主题写坏）。 */
    const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[^)]*\)|hsla?\(\s*[^)]*\)|transparent|currentColor|var\(--[A-Za-z0-9_-]+\))$/

    const zh = {
      nav: '外观颜色',
      title: '深色模式配色',
      intro: '用取色器调整下面的颜色，改动立刻作用到整个界面。只影响深色模式，切到浅色仍是官方配色。',
      enabled: '启用自定义配色',
      changed: '项已改',
      defaultBadge: '官方默认',
      resetAll: '全部恢复默认',
      reset: '重置',
      picker: '取色',
      value: '颜色值',
      presets: '预设配色',
      presetsHint: '点一套直接套用，之后还能按下面的取色器逐行微调。都只改深色模式。',
      noTheme: '没有检测到主题服务（ui-theme），配色无法应用。',
      rerun: '改完不用重启，设置页本身就会跟着变。',
    }

    const en = {
      nav: 'Appearance colors',
      title: 'Dark palette colors',
      intro: 'Pick colors below; changes apply to the whole UI instantly. Only the dark palette is affected — light mode keeps the official colors.',
      enabled: 'Enable custom colors',
      changed: 'changed',
      defaultBadge: 'Official default',
      resetAll: 'Reset all',
      reset: 'Reset',
      picker: 'Color picker',
      value: 'Color value',
      presets: 'Preset palettes',
      presetsHint: 'Pick a palette, then fine-tune any row below. Dark mode only.',
      noTheme: 'The theme service (ui-theme) is missing, so colors cannot be applied.',
      rerun: 'No restart needed — this page repaints as you pick.',
    }

    /** 翻译函数由 apply 绑定；组件渲染时读取。 */
    let t = (key) => key
    /** 主题服务；由 apply 注入。 */
    let theme = null
    /** 当前 token 覆盖层的释放函数（同一来源重复覆盖后旧的是 no-op）。 */
    let disposeLayer = null

    const CSS = `
.dshtc-root { display:flex; flex-direction:column; gap:12px; color:var(--dsw-alias-label-primary); font-size:13px; }
.dshtc-root *, .dshtc-root *::before, .dshtc-root *::after { box-sizing:border-box; }

.dshtc-head { display:flex; align-items:center; gap:8px; }
.dshtc-title { margin:0; font-size:14px; font-weight:600; }
.dshtc-badge { font-size:10px; line-height:16px; height:16px; padding:0 6px; border-radius:8px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); }
.dshtc-spacer { flex:1 1 auto; }
.dshtc-desc { margin:0; font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.dshtc-warn { margin:0; font-size:12px; line-height:18px; color:var(--dsw-alias-state-error-primary); }
.dshtc-foot { font-size:11px; color:var(--dsw-alias-label-secondary); }

.dshtc-btn { height:26px; padding:0 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-secondary); font-size:12px; cursor:pointer; transition:color .15s, border-color .15s, background-color .15s; }
.dshtc-btn:hover { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }

.dshtc-switch { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--dsw-alias-label-primary); cursor:pointer; user-select:none; }
.dshtc-switch input { width:14px; height:14px; margin:0; accent-color:var(--dsw-alias-state-business-primary); cursor:pointer; }

.dshtc-card { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-2); padding:4px 14px 10px; }
.dshtc-cardTitle { margin:10px 0 2px; font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }

.dshtc-presets { display:grid; grid-template-columns:repeat(auto-fill, minmax(156px, 1fr)); gap:8px; margin:10px 0 4px; }
.dshtc-preset { display:flex; flex-direction:column; gap:6px; align-items:stretch; text-align:left; padding:9px 10px; border-radius:10px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); cursor:pointer; font:inherit; transition:border-color .15s, background-color .15s; }
.dshtc-preset:hover { border-color:var(--dsw-alias-border-l2); }
.dshtc-preset.is-on { border-color:var(--dsw-alias-state-business-primary); box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary); }
.dshtc-presetName { font-size:12px; font-weight:600; line-height:16px; }
.dshtc-presetNote { font-size:10px; line-height:14px; color:var(--dsw-alias-label-secondary); }
.dshtc-presetSwatches { display:flex; gap:3px; }
.dshtc-presetSwatches i { width:14px; height:14px; border-radius:4px; border:1px solid var(--dsw-alias-border-l1); }
.dshtc-hint { font-size:11px; line-height:16px; color:var(--dsw-alias-label-secondary); margin-top:8px; }

.dshtc-row { display:flex; align-items:center; gap:12px; padding:10px 0; border-bottom:.5px solid var(--dsw-alias-border-l2); }
.dshtc-row:last-child { border-bottom:none; }
.dshtc-rowText { display:flex; flex-direction:column; gap:2px; flex:1 1 auto; min-width:0; }
.dshtc-rowLabel { display:flex; align-items:center; gap:6px; font-size:13px; line-height:20px; }
.dshtc-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-business-primary); flex:0 0 auto; }
.dshtc-rowDesc { font-size:11px; line-height:16px; color:var(--dsw-alias-label-secondary); }
.dshtc-token { font-family:var(--ds-font-family-code); font-size:10px; color:var(--dsw-alias-label-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

.dshtc-rowControl { display:inline-flex; align-items:center; gap:8px; flex:0 0 auto; }
.dshtc-picker { width:34px; height:28px; padding:0; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:transparent; cursor:pointer; }
.dshtc-picker::-webkit-color-swatch-wrapper { padding:3px; }
.dshtc-picker::-webkit-color-swatch { border:none; border-radius:5px; }
.dshtc-hex { width:104px; height:28px; padding:0 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-family:var(--ds-font-family-code); font-size:11px; }
.dshtc-hex:focus { outline:none; border-color:var(--dsw-alias-state-business-primary); }
.dshtc-hex.is-bad { border-color:var(--dsw-alias-state-error-primary); }
`

    // ---- 状态：{ enabled, dark: { token: value } } ----

    function sanitizeDark(value) {
      const dark = {}
      if (value === null || typeof value !== 'object') return dark
      for (const [token, color] of Object.entries(value)) {
        if (!BY_TOKEN.has(token)) continue
        if (typeof color !== 'string' || !COLOR_PATTERN.test(color.trim())) continue
        dark[token] = color.trim()
      }
      return dark
    }

    function defaultState() {
      return { enabled: true, dark: {} }
    }

    function loadState() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null || raw === '') return defaultState()
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return defaultState()
        return { enabled: parsed.enabled !== false, dark: sanitizeDark(parsed.dark) }
      } catch {
        return defaultState()
      }
    }

    let state = loadState()
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

    /** 把当前配色折成 token 覆盖层，交给主题服务。 */
    function applyOverrides() {
      if (theme === null || typeof theme.overrideTokens !== 'function') return
      const tokens = {}
      if (state.enabled) {
        for (const item of ITEMS) {
          const value = state.dark[item.token]
          if (typeof value !== 'string' || value === '') continue
          if (value.toLowerCase() === item.dark.toLowerCase()) continue
          tokens[item.token] = { light: item.light, dark: value }
        }
      }
      if (disposeLayer !== null) {
        const dispose = disposeLayer
        disposeLayer = null
        try {
          dispose()
        } catch {
          /* 已经失效的层忽略 */
        }
      }
      const names = Object.keys(tokens)
      if (names.length === 0) return
      try {
        disposeLayer = theme.overrideTokens(SOURCE, tokens)
      } catch (error) {
        disposeLayer = null
        try {
          console.warn('[theme-colors] 覆盖主题 token 失败：', error)
        } catch {
          /* 忽略 */
        }
      }
    }

    function commit() {
      applyOverrides()
      saveState()
      emit()
    }

    function setEnabled(next) {
      state = { ...state, enabled: next !== false }
      commit()
    }

    function setColor(token, color) {
      if (!BY_TOKEN.has(token)) return
      if (typeof color !== 'string') return
      const value = color.trim()
      if (!COLOR_PATTERN.test(value)) return
      state = { ...state, enabled: true, dark: { ...state.dark, [token]: value } }
      commit()
    }

    function resetColor(token) {
      if (!BY_TOKEN.has(token)) return
      const dark = { ...state.dark }
      delete dark[token]
      state = { ...state, dark }
      commit()
    }

    function resetAll() {
      state = { ...state, dark: {} }
      commit()
    }

    /** 套用预设：整份替换（点一下就是完整一套），并自动打开总开关。 */
    function applyPreset(id) {
      const preset = PRESETS.find((item) => item.id === id)
      if (preset === undefined) return
      state = { ...state, enabled: true, dark: { ...preset.tokens } }
      commit()
    }

    /** 当前配色与某套预设完全一致时返回它的 id，否则 null。 */
    function activePresetId() {
      const current = signatureOf(state.dark)
      if (current === '') return null
      for (const preset of PRESETS) {
        if (PRESET_SIGNATURES.get(preset.id) === current) return preset.id
      }
      return null
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

    // ---- 颜色工具 ----

    /** 取色器只认 #rrggbb，其它形式尽量折算过去。 */
    function toPickerHex(value, fallback) {
      const text = typeof value === 'string' ? value.trim() : ''
      if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase()
      if (/^#[0-9a-fA-F]{8}$/.test(text)) return text.slice(0, 7).toLowerCase()
      if (/^#[0-9a-fA-F]{3}$/.test(text)) return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase()
      if (/^#[0-9a-fA-F]{4}$/.test(text)) {
        const rgb = text.slice(1, 4)
        return `#${rgb[0]}${rgb[0]}${rgb[1]}${rgb[1]}${rgb[2]}${rgb[2]}`.toLowerCase()
      }
      const rgbMatch = text.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i)
      if (rgbMatch !== null) {
        const parts = [rgbMatch[1], rgbMatch[2], rgbMatch[3]].map((part) => {
          const channel = Math.min(255, Math.max(0, Number(part)))
          return channel.toString(16).padStart(2, '0')
        })
        return `#${parts.join('')}`
      }
      return /^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback.toLowerCase() : '#000000'
    }

    // ---- 组件 ----

    function PresetCard({ preset, active }) {
      const swatches = [
        preset.tokens['--dsw-alias-bg-base'],
        preset.tokens['--dsw-alias-bg-layer-2'],
        preset.tokens['--dsw-alias-label-primary'],
        preset.tokens['--dsw-alias-state-business-primary'],
      ]
      return h(
        'button',
        {
          className: active ? 'dshtc-preset is-on' : 'dshtc-preset',
          type: 'button',
          title: preset.note,
          'aria-pressed': active ? 'true' : 'false',
          onClick: () => applyPreset(preset.id),
        },
        h('span', { className: 'dshtc-presetName' }, preset.name),
        h('span', { className: 'dshtc-presetNote' }, preset.note),
        h(
          'span',
          { className: 'dshtc-presetSwatches' },
          swatches.map((color, index) => h('i', { key: index, style: { background: color } })),
        ),
      )
    }

    function ColorRow({ item }) {
      const current = useStore()
      const value = current.dark[item.token] ?? item.dark
      const changed = current.dark[item.token] !== undefined
      const [draft, setDraft] = React.useState(value)

      React.useEffect(() => {
        setDraft(value)
      }, [value])

      const valid = COLOR_PATTERN.test(draft.trim())

      return h(
        'div',
        { className: 'dshtc-row' },
        h(
          'div',
          { className: 'dshtc-rowText' },
          h(
            'div',
            { className: 'dshtc-rowLabel' },
            h('i', { className: 'dshtc-dot', style: { background: value } }),
            h('span', null, item.label),
            h('code', { className: 'dshtc-token' }, item.token),
          ),
          h('div', { className: 'dshtc-rowDesc' }, item.desc),
        ),
        h(
          'div',
          { className: 'dshtc-rowControl' },
          h('input', {
            className: 'dshtc-picker',
            type: 'color',
            value: toPickerHex(value, item.dark),
            title: t('picker'),
            'aria-label': `${item.token} ${t('picker')}`,
            onChange: (event) => setColor(item.token, event.target.value),
          }),
          h('input', {
            className: valid ? 'dshtc-hex' : 'dshtc-hex is-bad',
            type: 'text',
            spellCheck: false,
            value: draft,
            title: t('value'),
            'aria-label': `${item.token} ${t('value')}`,
            onChange: (event) => {
              const next = event.target.value
              setDraft(next)
              if (COLOR_PATTERN.test(next.trim())) setColor(item.token, next)
            },
            onBlur: () => {
              if (!COLOR_PATTERN.test(draft.trim())) setDraft(value)
            },
          }),
          changed
            ? h(
                'button',
                { className: 'dshtc-btn', type: 'button', onClick: () => resetColor(item.token) },
                t('reset'),
              )
            : null,
        ),
      )
    }

    function GroupCard({ group }) {
      return h(
        'div',
        { className: 'dshtc-card' },
        h('h4', { className: 'dshtc-cardTitle' }, group.title),
        group.items.map((item) => h(ColorRow, { key: item.token, item })),
      )
    }

    function ThemeColorsSection() {
      const current = useStore()
      const changedCount = Object.keys(current.dark).length
      return h(
        'div',
        { className: 'dshtc-root' },
        h('style', { key: 'style' }, CSS),
        h(
          'div',
          { className: 'dshtc-head', key: 'head' },
          h('h3', { className: 'dshtc-title' }, t('title')),
          h(
            'span',
            { className: 'dshtc-badge' },
            changedCount === 0 ? t('defaultBadge') : `${changedCount} ${t('changed')}`,
          ),
          h('span', { className: 'dshtc-spacer' }),
          changedCount > 0
            ? h('button', { className: 'dshtc-btn', type: 'button', onClick: resetAll }, t('resetAll'))
            : null,
        ),
        h('p', { className: 'dshtc-desc', key: 'intro' }, t('intro')),
        theme === null ? h('p', { className: 'dshtc-warn', key: 'warn' }, t('noTheme')) : null,
        h(
          'label',
          { className: 'dshtc-switch', key: 'switch' },
          h('input', {
            type: 'checkbox',
            checked: current.enabled,
            onChange: (event) => setEnabled(event.target.checked),
          }),
          h('span', null, t('enabled')),
        ),
        h(
          'div',
          { className: 'dshtc-card', key: 'presets' },
          h('h4', { className: 'dshtc-cardTitle' }, t('presets')),
          h(
            'div',
            { className: 'dshtc-presets' },
            PRESETS.map((preset) =>
              h(PresetCard, { key: preset.id, preset, active: preset.id === activePresetId() }),
            ),
          ),
          h('div', { className: 'dshtc-hint' }, t('presetsHint')),
        ),
        current.enabled ? GROUPS.map((group) => h(GroupCard, { key: group.id, group })) : null,
        h('div', { className: 'dshtc-foot', key: 'foot' }, t('rerun')),
      )
    }

    function apply(ctx) {
      t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'theme-colors: dictionaries')

      theme = ctx.theme ?? null
      // 早于设置页渲染先应用一次，页面一打开就是用户选的颜色。
      applyOverrides()

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
        'theme-colors: token override layer',
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'theme-colors',
            order: 5,
            label: () => t('nav'),
            locale: NS,
          },
          ThemeColorsSection,
        ),
      )
    }

    return { inject: ['slots', 'locale', 'theme'], apply }
  },
})
