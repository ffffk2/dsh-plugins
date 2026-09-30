/**
 * 外观颜色 —— Client 半。
 *
 * 在设置面板里注册一个 `settings.section` 页面：用取色器自由调整**深色与浅色两套**
 * 关键配色 token（主背景 / 侧栏 / 卡片 / 文字 / 强调色 / 分隔线）。
 *
 * 生效方式：调用官方主题服务 `ctx.theme.overrideTokens(source, tokens)`
 * ——这是 ui-theme 提供的公开扩展点（第三方主题用别名 token 覆盖），
 * ui-layout 会把快照里的 token 直接 setProperty 到 body 上，
 * 所以改动是立即生效的，不需要重启。
 *
 * 一层覆盖同时管住两套配色：每个 token 带 `{ light, dark }` 一对值，
 * 快照按当前主题的 `colorScheme` 取用对应那一侧，因此两套可以各自调整、互不串色；
 * 没被动过的一侧始终带回官方原值（等于官方配色）。
 *
 * 持久化：localStorage。DSH Desktop 固定监听 127.0.0.1:19387，
 * origin 稳定，因此跨重启有效；localStorage 不可用时退化为进程内。
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
     * - `dark` / `light`：官方原值，既是取色器的起点，也是「重置」的目标值
     * - 文案一律走 locale 字典（`labelKey` / `descKey`），中英文案都只写在字典里
     */
    const GROUPS = [
      {
        id: 'surface',
        titleKey: 'groupSurface',
        items: [
          { token: '--dsw-alias-bg-base', labelKey: 'labelBgBase', descKey: 'descBgBase', dark: '#151517', light: '#ffffff' },
          { token: '--dsw-specific-sidebar-fill', labelKey: 'labelSidebar', descKey: 'descSidebar', dark: '#1b1b1c', light: '#f9fafb' },
          { token: '--dsw-alias-bg-layer-1', labelKey: 'labelLayer1', descKey: 'descLayer1', dark: '#232324', light: '#ffffff' },
          { token: '--dsw-alias-bg-layer-2', labelKey: 'labelLayer2', descKey: 'descLayer2', dark: '#2c2c2e', light: '#ffffff' },
          { token: '--dsw-alias-bg-overlay', labelKey: 'labelOverlay', descKey: 'descOverlay', dark: '#43454a', light: '#e9ecf2' },
        ],
      },
      {
        id: 'text',
        titleKey: 'groupText',
        items: [
          { token: '--dsw-alias-label-primary', labelKey: 'labelPrimary', descKey: 'descPrimary', dark: '#f9fafb', light: '#0f1115' },
          { token: '--dsw-alias-label-secondary', labelKey: 'labelSecondary', descKey: 'descSecondary', dark: '#cfd3d6', light: '#61666b' },
        ],
      },
      {
        id: 'accent',
        titleKey: 'groupAccent',
        items: [
          { token: '--dsw-alias-brand-primary', labelKey: 'labelBrand', descKey: 'descBrand', dark: '#f9fafb', light: '#0f1115' },
          { token: '--dsw-alias-state-business-primary', labelKey: 'labelBusiness', descKey: 'descBusiness', dark: '#7aaaff', light: '#4176e6' },
        ],
      },
      {
        id: 'line',
        titleKey: 'groupLine',
        items: [
          { token: '--dsw-alias-border-l1', labelKey: 'labelBorderL1', descKey: 'descBorderL1', dark: '#ffffff0f', light: '#0000000a' },
          { token: '--dsw-alias-border-l2', labelKey: 'labelBorderL2', descKey: 'descBorderL2', dark: '#ffffff1f', light: '#0000001a' },
        ],
      },
    ]

    const ITEMS = GROUPS.reduce((all, group) => all.concat(group.items), [])
    const BY_TOKEN = new Map(ITEMS.map((item) => [item.token, item]))

    /**
     * 预设配色。每套只覆盖 `mode` 那一种配色的全部 11 个 token，
     * 所以点一下就是完整一套、不会残留上一套的颜色，另一种配色完全不受影响。
     *
     * 全部按 WCAG 相对亮度体检过（断言在 smoke.mjs 里）。
     * 深色侧：正文/底 7.4–11.4、次要文字/底 ≥ 4.7、链接/底 5.2–7.8、
     * 正文/卡片 ≥ 5.6、品牌色/按钮反色字 ≥ 10.9 —— 够读但不刺白。
     * 浅色侧：底色不用纯白（亮度 ≤ 0.92，官方浅色是 18.9 的硬对比，这里压到 7–13）、
     * 次要文字/底 ≥ 4.5、链接/底 4.5–9、正文/卡片 ≥ 5、品牌色/白 ≥ 4.5。
     * 自研的排在前面，其余取自公认的低对比护眼配色。
     */
    const PRESETS = [
      {
        id: 'warm-gray',
        mode: 'dark',
        nameKey: 'pWarmGray',
        noteKey: 'pWarmGrayNote',
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
        mode: 'dark',
        nameKey: 'pNightNavy',
        noteKey: 'pNightNavyNote',
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
        mode: 'dark',
        nameKey: 'pEverforest',
        noteKey: 'pEverforestNote',
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
        mode: 'dark',
        nameKey: 'pGruvbox',
        noteKey: 'pGruvboxNote',
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
        mode: 'dark',
        nameKey: 'pNord',
        noteKey: 'pNordNote',
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
        mode: 'dark',
        nameKey: 'pSolarized',
        noteKey: 'pSolarizedNote',
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
        mode: 'dark',
        nameKey: 'pCatppuccin',
        noteKey: 'pCatppuccinNote',
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
      {
        id: 'bean-green',
        mode: 'light',
        nameKey: 'pBeanGreen',
        noteKey: 'pBeanGreenNote',
        tokens: {
          '--dsw-alias-bg-base': '#c7e5cd',
          '--dsw-specific-sidebar-fill': '#bcddc3',
          '--dsw-alias-bg-layer-1': '#cfe9d4',
          '--dsw-alias-bg-layer-2': '#dbf0df',
          '--dsw-alias-bg-overlay': '#b0d5b8',
          '--dsw-alias-label-primary': '#24382a',
          '--dsw-alias-label-secondary': '#4b6152',
          '--dsw-alias-brand-primary': '#1d2f23',
          '--dsw-alias-state-business-primary': '#1c6a4a',
          '--dsw-alias-border-l1': '#00000014',
          '--dsw-alias-border-l2': '#00000026',
        },
      },
      {
        id: 'paper',
        mode: 'light',
        nameKey: 'pPaper',
        noteKey: 'pPaperNote',
        tokens: {
          '--dsw-alias-bg-base': '#f4edde',
          '--dsw-specific-sidebar-fill': '#ebe3d1',
          '--dsw-alias-bg-layer-1': '#f8f3e8',
          '--dsw-alias-bg-layer-2': '#fdfaf2',
          '--dsw-alias-bg-overlay': '#e2d8c0',
          '--dsw-alias-label-primary': '#3a352b',
          '--dsw-alias-label-secondary': '#6b6355',
          '--dsw-alias-brand-primary': '#2f2b22',
          '--dsw-alias-state-business-primary': '#2a6191',
          '--dsw-alias-border-l1': '#00000012',
          '--dsw-alias-border-l2': '#00000024',
        },
      },
      {
        id: 'mist',
        mode: 'light',
        nameKey: 'pMist',
        noteKey: 'pMistNote',
        tokens: {
          '--dsw-alias-bg-base': '#eef1f4',
          '--dsw-specific-sidebar-fill': '#e5eaf0',
          '--dsw-alias-bg-layer-1': '#f4f7fa',
          '--dsw-alias-bg-layer-2': '#fbfdfe',
          '--dsw-alias-bg-overlay': '#dce2ea',
          '--dsw-alias-label-primary': '#2b333d',
          '--dsw-alias-label-secondary': '#5c6673',
          '--dsw-alias-brand-primary': '#222a33',
          '--dsw-alias-state-business-primary': '#2c6ba8',
          '--dsw-alias-border-l1': '#00000012',
          '--dsw-alias-border-l2': '#00000024',
        },
      },
      {
        id: 'everforest-light',
        mode: 'light',
        nameKey: 'pEverforestLight',
        noteKey: 'pEverforestLightNote',
        tokens: {
          '--dsw-alias-bg-base': '#f8f1dc',
          '--dsw-specific-sidebar-fill': '#efe9d2',
          '--dsw-alias-bg-layer-1': '#fbf6e8',
          '--dsw-alias-bg-layer-2': '#fffdf6',
          '--dsw-alias-bg-overlay': '#e8e2c9',
          '--dsw-alias-label-primary': '#46535a',
          '--dsw-alias-label-secondary': '#646d5e',
          '--dsw-alias-brand-primary': '#37423f',
          '--dsw-alias-state-business-primary': '#2c6d94',
          '--dsw-alias-border-l1': '#00000012',
          '--dsw-alias-border-l2': '#00000024',
        },
      },
      {
        id: 'gruvbox-light',
        mode: 'light',
        nameKey: 'pGruvboxLight',
        noteKey: 'pGruvboxLightNote',
        tokens: {
          '--dsw-alias-bg-base': '#fbf1c7',
          '--dsw-specific-sidebar-fill': '#f2e5bc',
          '--dsw-alias-bg-layer-1': '#f9f5d7',
          '--dsw-alias-bg-layer-2': '#fffbe6',
          '--dsw-alias-bg-overlay': '#ebdbb2',
          '--dsw-alias-label-primary': '#3c3836',
          '--dsw-alias-label-secondary': '#665c54',
          '--dsw-alias-brand-primary': '#32302f',
          '--dsw-alias-state-business-primary': '#076678',
          '--dsw-alias-border-l1': '#00000014',
          '--dsw-alias-border-l2': '#00000026',
        },
      },
      {
        id: 'nord-light',
        mode: 'light',
        nameKey: 'pNordLight',
        noteKey: 'pNordLightNote',
        tokens: {
          '--dsw-alias-bg-base': '#eceff4',
          '--dsw-specific-sidebar-fill': '#e5e9f0',
          '--dsw-alias-bg-layer-1': '#f2f4f8',
          '--dsw-alias-bg-layer-2': '#fafbfc',
          '--dsw-alias-bg-overlay': '#d8dee9',
          '--dsw-alias-label-primary': '#2e3440',
          '--dsw-alias-label-secondary': '#4c566a',
          '--dsw-alias-brand-primary': '#2e3440',
          '--dsw-alias-state-business-primary': '#43608a',
          '--dsw-alias-border-l1': '#00000012',
          '--dsw-alias-border-l2': '#00000024',
        },
      },
      {
        id: 'solarized-light',
        mode: 'light',
        nameKey: 'pSolarizedLight',
        noteKey: 'pSolarizedLightNote',
        tokens: {
          '--dsw-alias-bg-base': '#f7efda',
          '--dsw-specific-sidebar-fill': '#efe7d2',
          '--dsw-alias-bg-layer-1': '#faf4e4',
          '--dsw-alias-bg-layer-2': '#fffdf6',
          '--dsw-alias-bg-overlay': '#e9e2cb',
          '--dsw-alias-label-primary': '#3d4e55',
          '--dsw-alias-label-secondary': '#5d6f74',
          '--dsw-alias-brand-primary': '#37474d',
          '--dsw-alias-state-business-primary': '#1f6f9f',
          '--dsw-alias-border-l1': '#00000012',
          '--dsw-alias-border-l2': '#00000024',
        },
      },
      {
        id: 'latte',
        mode: 'light',
        nameKey: 'pLatte',
        noteKey: 'pLatteNote',
        tokens: {
          '--dsw-alias-bg-base': '#eff1f5',
          '--dsw-specific-sidebar-fill': '#e6e9ef',
          '--dsw-alias-bg-layer-1': '#e9ecf2',
          '--dsw-alias-bg-layer-2': '#fbfcfd',
          '--dsw-alias-bg-overlay': '#dce0e8',
          '--dsw-alias-label-primary': '#4c4f69',
          '--dsw-alias-label-secondary': '#63667c',
          '--dsw-alias-brand-primary': '#3c3f57',
          '--dsw-alias-state-business-primary': '#1b60d8',
          '--dsw-alias-border-l1': '#00000012',
          '--dsw-alias-border-l2': '#00000024',
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
      title: '界面配色',
      intro: '深色、浅色两套都能改：先在上面选要编辑的模式，再点一套预设或逐行取色；没动过的那一套继续用官方配色。',
      enabled: '启用自定义配色',
      changed: '项已改',
      defaultBadge: '官方默认',
      resetAll: '全部恢复默认',
      reset: '重置',
      picker: '取色',
      value: '颜色值',
      modeLabel: '编辑',
      modeHint: '切换要编辑的配色：深色与浅色各存各的，互不影响',
      modeDark: '深色',
      modeLight: '浅色',
      presets: '预设配色',
      presetsHint: '点一下整套生效，只覆盖当前模式的 11 个 token，另一种模式不受影响；之后还能逐行微调。',
      noTheme: '没有检测到主题服务（ui-theme），配色无法应用。',
      rerun: '改完不用重启，设置页本身就会跟着变。',
      groupSurface: '背景与表面',
      groupText: '文字',
      groupAccent: '强调色',
      groupLine: '分隔线',
      labelBgBase: '主背景',
      descBgBase: '整个应用的底层画布',
      labelSidebar: '侧边栏',
      descSidebar: '左侧栏与窗口标题栏底色',
      labelLayer1: '一级表面',
      descLayer1: '从画布浮起的第一层容器',
      labelLayer2: '二级表面',
      descLayer2: '卡片、模块与嵌套容器',
      labelOverlay: '浮层底色',
      descOverlay: '弹窗、下拉与浮出面板',
      labelPrimary: '正文',
      descPrimary: '主要文本与标题',
      labelSecondary: '次要文字',
      descSecondary: '说明、时间戳与辅助信息',
      labelBrand: '品牌强调',
      descBrand: '主按钮填充、选中态与品牌标识',
      labelBusiness: '链接与焦点',
      descBusiness: '链接文字、焦点环与业务高亮',
      labelBorderL1: '细边框',
      descBorderL1: '列表与卡片的分隔线，可用 8 位十六进制带透明度',
      labelBorderL2: '粗边框',
      descBorderL2: '对比更强的描边，可用 8 位十六进制带透明度',
      pWarmGray: '暖灰护眼',
      pWarmGrayNote: '自研 · 中性偏暖、零蓝光刺激，深夜最耐看',
      pNightNavy: '深蓝夜',
      pNightNavyNote: '自研 · 低饱和深夜蓝，正文不刺白',
      pEverforest: '常青 Everforest',
      pEverforestNote: '低对比绿灰，公认久看不累',
      pGruvbox: '格鲁布 Gruvbox',
      pGruvboxNote: '暖色低对比经典，纸质暖调',
      pNord: '北境 Nord',
      pNordNote: '冷灰蓝，极简低饱和',
      pSolarized: '日光 Solarized',
      pSolarizedNote: '经典青灰底，刻意压低对比',
      pCatppuccin: '摩卡 Catppuccin',
      pCatppuccinNote: '柔和粉紫，柔光感',
      pBeanGreen: '豆沙绿',
      pBeanGreenNote: '经典护眼绿底，久看最舒服',
      pPaper: '米白护眼',
      pPaperNote: '自研 · 米白暖调，比纯白柔和',
      pMist: '雾青',
      pMistNote: '自研 · 冷调雾青，清爽不刺眼',
      pEverforestLight: '常青 Everforest Light',
      pEverforestLightNote: 'Everforest 浅色，米绿低对比',
      pGruvboxLight: '格鲁布 Gruvbox Light',
      pGruvboxLightNote: 'Gruvbox 浅色，牛皮纸暖黄',
      pNordLight: '北境 Nord Light',
      pNordLightNote: 'Nord 浅色，冷雪灰蓝',
      pSolarizedLight: '日光 Solarized Light',
      pSolarizedLightNote: 'Solarized 浅色，米黄为底',
      pLatte: '摩卡 Catppuccin Latte',
      pLatteNote: 'Catppuccin 浅色，柔和奶咖',
    }

    const en = {
      nav: 'Appearance colors',
      title: 'Interface colors',
      intro: 'Both palettes are editable: switch the mode above, then pick a preset or fine-tune row by row. A palette you leave alone keeps the official colors.',
      enabled: 'Enable custom colors',
      changed: 'changed',
      defaultBadge: 'Official default',
      resetAll: 'Reset all',
      reset: 'Reset',
      picker: 'Color picker',
      value: 'Color value',
      modeLabel: 'Editing',
      modeHint: 'Switch which palette you are editing; each side is stored separately',
      modeDark: 'Dark',
      modeLight: 'Light',
      presets: 'Preset palettes',
      presetsHint: 'One click fills all 11 tokens of the current mode and leaves the other mode untouched; fine-tune any row afterwards.',
      noTheme: 'The theme service (ui-theme) is missing, so colors cannot be applied.',
      rerun: 'No restart needed — this page repaints as you pick.',
      groupSurface: 'Background & surfaces',
      groupText: 'Text',
      groupAccent: 'Accent',
      groupLine: 'Dividers',
      labelBgBase: 'Canvas',
      descBgBase: 'Base background behind the whole app',
      labelSidebar: 'Sidebar',
      descSidebar: 'Left rail and window title bar',
      labelLayer1: 'Surface 1',
      descLayer1: 'First level raised above the canvas',
      labelLayer2: 'Surface 2',
      descLayer2: 'Cards, modules and nested containers',
      labelOverlay: 'Overlay',
      descOverlay: 'Dialogs, dropdowns and popovers',
      labelPrimary: 'Body text',
      descPrimary: 'Primary text and headings',
      labelSecondary: 'Secondary text',
      descSecondary: 'Captions, timestamps and hints',
      labelBrand: 'Brand accent',
      descBrand: 'Primary button fill, selected state and brand marks',
      labelBusiness: 'Links & focus',
      descBusiness: 'Link text, focus ring and business highlights',
      labelBorderL1: 'Hairline border',
      descBorderL1: 'List and card dividers; 8-digit hex carries alpha',
      labelBorderL2: 'Strong border',
      descBorderL2: 'Higher-contrast outline; 8-digit hex carries alpha',
      pWarmGray: 'Warm gray',
      pWarmGrayNote: 'Built-in · neutral warm, no blue glare, easiest at night',
      pNightNavy: 'Night navy',
      pNightNavyNote: 'Built-in · low-saturation midnight blue, no harsh white text',
      pEverforest: 'Everforest',
      pEverforestNote: 'Low-contrast green gray, famously easy on the eyes',
      pGruvbox: 'Gruvbox',
      pGruvboxNote: 'Warm low-contrast classic, paper-like warmth',
      pNord: 'Nord',
      pNordNote: 'Cool gray blue, minimal and desaturated',
      pSolarized: 'Solarized',
      pSolarizedNote: 'Classic teal-gray base, deliberately low contrast',
      pCatppuccin: 'Catppuccin',
      pCatppuccinNote: 'Soft pink purple, gentle glow',
      pBeanGreen: 'Bean green',
      pBeanGreenNote: 'The classic Chinese eye-care green base',
      pPaper: 'Warm paper',
      pPaperNote: 'Built-in · warm off-white, softer than pure white',
      pMist: 'Mist gray',
      pMistNote: 'Built-in · cool misty gray, crisp without glare',
      pEverforestLight: 'Everforest Light',
      pEverforestLightNote: 'Everforest light, low-contrast cream green',
      pGruvboxLight: 'Gruvbox Light',
      pGruvboxLightNote: 'Gruvbox light, kraft-paper warm yellow',
      pNordLight: 'Nord Light',
      pNordLightNote: 'Nord light, snow gray blue',
      pSolarizedLight: 'Solarized Light',
      pSolarizedLightNote: 'Solarized light on a cream base',
      pLatte: 'Catppuccin Latte',
      pLatteNote: 'Catppuccin light, soft milk coffee',
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

.dshtc-modes { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dshtc-modesLabel { font-size:12px; color:var(--dsw-alias-label-secondary); margin-right:2px; }
.dshtc-mode { display:inline-flex; align-items:center; gap:6px; height:26px; padding:0 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; transition:color .15s, border-color .15s; }
.dshtc-mode:hover { border-color:var(--dsw-alias-border-l2); }
.dshtc-mode.is-on { border-color:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-label-primary); }
.dshtc-modeCount { font-size:10px; line-height:14px; min-width:14px; padding:0 4px; border-radius:7px; text-align:center; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); }

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

    // ---- 状态：{ enabled, dark: { token: value }, light: { token: value } } ----

    /** 两种配色模式；顺序也是界面上 tab 的顺序。 */
    const MODES = ['dark', 'light']

    /** 清洗某一侧的取色表：不认识的 token、不合法的颜色一律丢掉。 */
    function sanitizeColors(value) {
      const colors = {}
      if (value === null || typeof value !== 'object') return colors
      for (const [token, color] of Object.entries(value)) {
        if (!BY_TOKEN.has(token)) continue
        if (typeof color !== 'string' || !COLOR_PATTERN.test(color.trim())) continue
        colors[token] = color.trim()
      }
      return colors
    }

    function defaultState() {
      return { enabled: true, dark: {}, light: {} }
    }

    function loadState() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null || raw === '') return defaultState()
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return defaultState()
        // 旧版本只存了 dark，没有 light —— 缺的那侧按“没改过”处理，老数据照常能用。
        return {
          enabled: parsed.enabled !== false,
          dark: sanitizeColors(parsed.dark),
          light: sanitizeColors(parsed.light),
        }
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

    /** 某一侧某个 token 的当前值：用户没改过就是官方原值。 */
    function pickColor(mode, item) {
      const value = state[mode][item.token]
      if (typeof value !== 'string' || value === '') return item[mode].toLowerCase()
      return value
    }

    /**
     * 把两套配色折成同一层 token 覆盖，交给主题服务。
     * 两侧都没被动过的 token 不进层：少写几个属性，也少一次主题广播。
     */
    function applyOverrides() {
      if (theme === null || typeof theme.overrideTokens !== 'function') return
      const tokens = {}
      if (state.enabled) {
        for (const item of ITEMS) {
          const dark = pickColor('dark', item)
          const light = pickColor('light', item)
          if (dark === item.dark.toLowerCase() && light === item.light.toLowerCase()) continue
          tokens[item.token] = { light, dark }
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

    function setColor(mode, token, color) {
      if (!MODES.includes(mode)) return
      if (!BY_TOKEN.has(token)) return
      if (typeof color !== 'string') return
      const value = color.trim()
      if (!COLOR_PATTERN.test(value)) return
      state = { ...state, enabled: true, [mode]: { ...state[mode], [token]: value } }
      commit()
    }

    function resetColor(mode, token) {
      if (!MODES.includes(mode)) return
      if (!BY_TOKEN.has(token)) return
      const colors = { ...state[mode] }
      delete colors[token]
      state = { ...state, [mode]: colors }
      commit()
    }

    function resetAll() {
      state = { ...state, dark: {}, light: {} }
      commit()
    }

    /** 套用预设：整份替换指定的一侧（点一下就是完整一套），并自动打开总开关。 */
    function applyPreset(id) {
      const preset = PRESETS.find((item) => item.id === id)
      if (preset === undefined) return
      state = { ...state, enabled: true, [preset.mode]: { ...preset.tokens } }
      commit()
    }

    /** 该模式当前与某套预设完全一致时返回它的 id，否则 null。 */
    function activePresetId(mode) {
      const current = signatureOf(state[mode])
      if (current === '') return null
      for (const preset of PRESETS) {
        if (preset.mode !== mode) continue
        if (PRESET_SIGNATURES.get(preset.id) === current) return preset.id
      }
      return null
    }

    // ---- 设置页在编辑哪一套 ----

    /** 当前生效的配色方案（'dark' / 'light'）：主题快照优先，退回 body 上的标记。 */
    function activeMode() {
      if (theme !== null && typeof theme.getTheme === 'function') {
        try {
          const scheme = theme.getTheme()?.active?.colorScheme
          if (MODES.includes(scheme)) return scheme
        } catch {
          /* 快照读不到就继续往下退 */
        }
      }
      try {
        if (typeof document !== 'undefined' && document.body?.hasAttribute('data-ds-dark-theme') === true) return 'dark'
      } catch {
        /* 自检环境里没有 document */
      }
      return 'light'
    }

    /**
     * 设置页正在编辑的模式。默认跟着当前配色走，但要等第一次渲染才知道，
     * 所以先给个兜底值，apply 里再对齐。
     */
    let uiMode = 'light'
    /** 用户手动切过模式就钉住，不再跟着配色方案跳。 */
    let modePinned = false

    function setEditMode(mode) {
      if (!MODES.includes(mode)) return
      uiMode = mode
      // 选回“当前正在生效”的那一侧时恢复跟随，选另一侧则钉住。
      modePinned = mode !== activeMode()
      emit()
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
      const note = t(preset.noteKey)
      return h(
        'button',
        {
          className: active ? 'dshtc-preset is-on' : 'dshtc-preset',
          type: 'button',
          title: note,
          'aria-pressed': active ? 'true' : 'false',
          onClick: () => applyPreset(preset.id),
        },
        h('span', { className: 'dshtc-presetName' }, t(preset.nameKey)),
        h('span', { className: 'dshtc-presetNote' }, note),
        h(
          'span',
          { className: 'dshtc-presetSwatches' },
          swatches.map((color, index) => h('i', { key: index, style: { background: color } })),
        ),
      )
    }

    /** 模式切换：一次只编辑一套配色，卡片和取色器都跟着走。 */
    function ModeTabs({ current }) {
      return h(
        'div',
        { className: 'dshtc-modes' },
        h('span', { className: 'dshtc-modesLabel' }, t('modeLabel')),
        MODES.map((mode) => {
          const count = Object.keys(current[mode]).length
          const on = mode === uiMode
          return h(
            'button',
            {
              key: mode,
              className: on ? 'dshtc-mode is-on' : 'dshtc-mode',
              type: 'button',
              title: t('modeHint'),
              'aria-pressed': on ? 'true' : 'false',
              onClick: () => setEditMode(mode),
            },
            t(mode === 'dark' ? 'modeDark' : 'modeLight'),
            count > 0 ? h('span', { className: 'dshtc-modeCount' }, String(count)) : null,
          )
        }),
      )
    }

    function ColorRow({ item, mode }) {
      const current = useStore()
      const stored = current[mode][item.token]
      const value = typeof stored === 'string' ? stored : item[mode]
      const changed = stored !== undefined
      const [draft, setDraft] = React.useState(value)

      React.useEffect(() => {
        setDraft(value)
      }, [value, mode])

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
            h('span', null, t(item.labelKey)),
            h('code', { className: 'dshtc-token' }, item.token),
          ),
          h('div', { className: 'dshtc-rowDesc' }, t(item.descKey)),
        ),
        h(
          'div',
          { className: 'dshtc-rowControl' },
          h('input', {
            className: 'dshtc-picker',
            type: 'color',
            value: toPickerHex(value, item[mode]),
            title: t('picker'),
            // aria-label 里带上 token 名：读屏能听出是「正文」还是「主背景」，也方便自检定位。
            'aria-label': `${t(item.labelKey)} (${item.token}) ${t('picker')}`,
            onChange: (event) => setColor(mode, item.token, event.target.value),
          }),
          h('input', {
            className: valid ? 'dshtc-hex' : 'dshtc-hex is-bad',
            type: 'text',
            spellCheck: false,
            value: draft,
            title: t('value'),
            'aria-label': `${t(item.labelKey)} (${item.token}) ${t('value')}`,
            onChange: (event) => {
              const next = event.target.value
              setDraft(next)
              if (COLOR_PATTERN.test(next.trim())) setColor(mode, item.token, next)
            },
            onBlur: () => {
              if (!COLOR_PATTERN.test(draft.trim())) setDraft(value)
            },
          }),
          changed
            ? h(
                'button',
                { className: 'dshtc-btn', type: 'button', onClick: () => resetColor(mode, item.token) },
                t('reset'),
              )
            : null,
        ),
      )
    }

    function GroupCard({ group, mode }) {
      return h(
        'div',
        { className: 'dshtc-card' },
        h('h4', { className: 'dshtc-cardTitle' }, t(group.titleKey)),
        group.items.map((item) => h(ColorRow, { key: item.token, item, mode })),
      )
    }

    function ThemeColorsSection() {
      const current = useStore()
      const mode = uiMode
      const modeName = t(mode === 'dark' ? 'modeDark' : 'modeLight')
      const changedCount = Object.keys(current.dark).length + Object.keys(current.light).length
      const presets = PRESETS.filter((preset) => preset.mode === mode)
      const active = activePresetId(mode)
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
        h(ModeTabs, { key: 'modes', current }),
        h(
          'div',
          { className: 'dshtc-card', key: 'presets' },
          h('h4', { className: 'dshtc-cardTitle' }, `${t('presets')} · ${modeName}`),
          h(
            'div',
            { className: 'dshtc-presets' },
            presets.map((preset) => h(PresetCard, { key: preset.id, preset, active: preset.id === active })),
          ),
          h('div', { className: 'dshtc-hint' }, t('presetsHint')),
        ),
        current.enabled ? GROUPS.map((group) => h(GroupCard, { key: group.id, group, mode })) : null,
        h('div', { className: 'dshtc-foot', key: 'foot' }, t('rerun')),
      )
    }

    function apply(ctx) {
      t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'theme-colors: dictionaries')

      theme = ctx.theme ?? null
      // 设置页默认编辑「当前正在生效」的那一套，跟着主题偏好走。
      uiMode = activeMode()
      // 早于设置页渲染先应用一次，页面一打开就是用户选的颜色。
      applyOverrides()

      // 用户没手动切过模式时，设置页跟着当前配色方案走（主题偏好里切深/浅色会广播）。
      ctx.effect(
        () =>
          ctx.on('theme/change', () => {
            if (!modePinned) uiMode = activeMode()
            emit()
          }),
        'theme-colors: follow the active color scheme',
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
