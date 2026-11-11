/**
 * Token 统计 —— Client 半。
 *
 * 设置面板里的一个 `settings.section` 页面，布局对齐 ZCode（zai-org/ZCode）的
 * 「设置 → Usage」：
 *   ① 指标条：累计 Token / 峰值 Token / 最长会话 / 当前连续天数 / 最长连续天数
 *   ② Token 活动热力图：最近 52 个自然周，可切「每日 / 每周 / 累计」
 *   ③ 时间范围（近 7 日 / 近 30 日）+ 每日多模型折线趋势图（悬停看当天各模型）
 *   ④ 模型用量环形图 + 明细列表（占比、Token 数）
 *   ⑤ 底部：刷新 / 清零，以及数据文件与兜底提示
 *
 * 数据来自同包 Host 半的 GET /token-usage/stats?range=7d|30d|all；清零走
 * POST /token-usage/reset。图表全部手写 SVG，只用宿主主题 token 着色，
 * 不引入任何第三方图表库或 Harness Client 包。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-token-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'token-usage'
    const STATS_PATH = '/token-usage/stats'
    const RESET_PATH = '/token-usage/reset'
    const RANGE_OPTIONS = ['7d', '30d']
    const HEATMAP_MODES = ['daily', 'weekly', 'cumulative']
    /** 环形图最多画 6 片，多出来的合并成「其他模型」（与 ZCode 一致）。 */
    const MAX_PIE_SLICES = 6
    const OTHER_KEY = '__other__'
    const MERGED_KEY = '__merged__'
    const DURATION_UNITS = [
      { key: 'durationDay', ms: 86_400_000 },
      { key: 'durationHour', ms: 3_600_000 },
      { key: 'durationMinute', ms: 60_000 },
      { key: 'durationSecond', ms: 1_000 },
    ]

    const zh = {
      nav: 'Token 统计',
      title: 'Token 统计',
      live: '实时记录中',
      lifetimeTotalTokens: '累计 Token 数',
      lifetimePeakTokens: '峰值 Token 数',
      longestSession: '最长会话',
      currentStreak: '当前连续天数',
      longestStreak: '最长连续天数',
      heatmapTitle: 'Token 活动',
      heatmapDaily: '每日',
      heatmapWeekly: '每周',
      heatmapCumulative: '累计',
      heatmapLess: '较少',
      heatmapMore: '较多',
      heatmapCell: '{date}\n{tokens} tokens · {calls} 次调用',
      heatmapWeeklyCell: '{date} 当周\n{tokens} tokens · {calls} 次调用',
      heatmapCumulativeCell: '截至 {date} 当周累计\n{tokens} tokens · {calls} 次调用',
      rangeTitle: '时间范围',
      range7d: '近 7 日',
      range30d: '近 30 日',
      dailyChartTitle: '每日 Token 趋势图',
      modelChartTitle: '模型用量',
      otherModel: '其他模型',
      unattributed: '未分模型',
      unknownModel: '未知模型',
      tokenUnit: 'tokens',
      emptyTitle: '还没有可展示的数据',
      emptyDescription: '发出任意一次模型对话后回到这里即可看到统计。',
      emptyRange: '这个时间范围内没有用量。',
      loading: '加载中…',
      refresh: '刷新',
      reset: '清零',
      confirmReset: '确定清零累计统计吗？此操作不可撤销；清零前会自动留一份快照。',
      resetDone: '已清零',
      file: '数据文件',
      since: '统计起始',
      updated: '最近更新',
      build: '代码版本',
      failed: '读取失败：',
      corruptBackup: '上次启动时累计文件损坏，已备份到',
      restoredFrom: '已从快照恢复累计：',
      resetBackup: '清零前的数据已快照保存：',
      staleTitle: '正在运行的是旧版插件代码',
      staleHint: '磁盘上的 index.js 已更新，但 DSH 仍在使用启动时加载的版本（Node 会缓存已导入的模块）。请完全退出并重启 DSH Desktop，否则新功能不会生效。',
      durationDay: '天',
      durationHour: '小时',
      durationMinute: '分钟',
      durationSecond: '秒',
    }

    const en = {
      nav: 'Token Usage',
      title: 'Token usage',
      live: 'Recording',
      lifetimeTotalTokens: 'Total tokens',
      lifetimePeakTokens: 'Peak day',
      longestSession: 'Longest session',
      currentStreak: 'Current streak',
      longestStreak: 'Longest streak',
      heatmapTitle: 'Token activity',
      heatmapDaily: 'Daily',
      heatmapWeekly: 'Weekly',
      heatmapCumulative: 'Cumulative',
      heatmapLess: 'Less',
      heatmapMore: 'More',
      heatmapCell: '{date}\n{tokens} tokens · {calls} calls',
      heatmapWeeklyCell: 'Week of {date}\n{tokens} tokens · {calls} calls',
      heatmapCumulativeCell: 'Cumulative through {date}\n{tokens} tokens · {calls} calls',
      rangeTitle: 'Time range',
      range7d: 'Last 7 days',
      range30d: 'Last 30 days',
      dailyChartTitle: 'Daily token trend',
      modelChartTitle: 'Model usage',
      otherModel: 'Other models',
      unattributed: 'Unattributed',
      unknownModel: 'Unknown model',
      tokenUnit: 'tokens',
      emptyTitle: 'Nothing to show yet',
      emptyDescription: 'Send one model message and come back.',
      emptyRange: 'No usage in this range.',
      loading: 'Loading…',
      refresh: 'Refresh',
      reset: 'Reset',
      confirmReset: 'Reset all accumulated usage? This cannot be undone; a snapshot is taken first.',
      resetDone: 'Cleared',
      file: 'Data file',
      since: 'Counting since',
      updated: 'Last updated',
      build: 'Build',
      failed: 'Load failed: ',
      corruptBackup: 'The usage file was corrupt at last startup; backed up to',
      restoredFrom: 'Usage restored from snapshot:',
      resetBackup: 'The data cleared by reset was snapshotted to:',
      staleTitle: 'An older build of the plugin is running',
      staleHint: 'index.js on disk is newer, but DSH still uses the version loaded at startup (Node caches imported modules). Fully quit and restart DSH Desktop, or the new behaviour will not apply.',
      durationDay: 'd',
      durationHour: 'h',
      durationMinute: 'm',
      durationSecond: 's',
    }

    // 由 apply 绑定的翻译函数；组件渲染时读取。
    let t = (key) => key

    const CSS = `
.dshtu-root { display:flex; flex-direction:column; gap:14px; color:var(--dsw-alias-label-primary); font-size:12px; line-height:1.45; }
.dshtu-root *, .dshtu-root *::before, .dshtu-root *::after { box-sizing:border-box; }
.dshtu-head { display:flex; align-items:center; gap:8px; min-width:0; }
.dshtu-title { margin:0; font-size:14px; font-weight:600; }
.dshtu-live { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshtu-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); animation:dshtu-pulse 2s ease-in-out infinite; }
@keyframes dshtu-pulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }
.dshtu-spacer { flex:1 1 auto; }
.dshtu-ok { color:var(--dsw-alias-state-success-primary); font-size:11px; }
.dshtu-btn { height:26px; padding:0 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); font-size:12px; cursor:pointer; transition:color .15s, border-color .15s; }
.dshtu-btn:hover:not([disabled]) { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dshtu-btn[disabled] { opacity:.45; cursor:default; }
.dshtu-btn.is-primary { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dshtu-tabs { display:inline-flex; flex:0 0 auto; gap:2px; padding:2px; border-radius:999px; background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); }
.dshtu-tab { height:22px; padding:0 10px; border:0; border-radius:999px; background:transparent; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:22px; cursor:pointer; }
.dshtu-tab.is-on { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }
.dshtu-card { min-width:0; padding:14px 16px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); }
.dshtu-card-head { display:flex; align-items:center; gap:10px; min-width:0; margin-bottom:10px; }
.dshtu-card-title { margin:0; font-size:12px; font-weight:600; }
.dshtu-strip { display:flex; overflow:hidden; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); }
.dshtu-strip-cell { flex:1 1 0; min-width:0; padding:12px 10px; text-align:center; }
.dshtu-strip-cell + .dshtu-strip-cell { border-left:1px solid var(--dsw-alias-border-l2); }
.dshtu-strip-value { overflow:hidden; font-size:16px; font-weight:600; font-variant-numeric:tabular-nums; text-overflow:ellipsis; white-space:nowrap; }
.dshtu-strip-label { overflow:hidden; margin-top:4px; font-size:11px; color:var(--dsw-alias-label-secondary); text-overflow:ellipsis; white-space:nowrap; }
.dshtu-heatmap-grid { display:grid; grid-auto-flow:column; grid-auto-columns:minmax(0,1fr); gap:2px; }
.dshtu-heatmap-col { display:grid; grid-template-rows:repeat(7, auto); gap:2px; min-width:0; }
.dshtu-heatmap-cell { width:100%; aspect-ratio:1 / 1; border-radius:3px; background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); }
.dshtu-heatmap-cell[data-level="1"] { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent); }
.dshtu-heatmap-cell[data-level="2"] { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 44%, transparent); }
.dshtu-heatmap-cell[data-level="3"] { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 66%, transparent); }
.dshtu-heatmap-cell[data-level="4"] { background:var(--dsw-alias-brand-primary); }
.dshtu-heatmap-cell.is-empty { background:transparent; }
.dshtu-heatmap-months { display:grid; grid-template-columns:repeat(52, minmax(0,1fr)); gap:2px; margin-top:6px; }
.dshtu-month-label { overflow:hidden; font-size:10px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dshtu-heat-legend { display:flex; align-items:center; justify-content:flex-end; gap:4px; margin-top:8px; font-size:10px; color:var(--dsw-alias-label-secondary); }
.dshtu-heat-legend-cell { width:9px; height:9px; border-radius:2px; background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); }
.dshtu-heat-legend-cell[data-level="1"] { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent); }
.dshtu-heat-legend-cell[data-level="2"] { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 44%, transparent); }
.dshtu-heat-legend-cell[data-level="3"] { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 66%, transparent); }
.dshtu-heat-legend-cell[data-level="4"] { background:var(--dsw-alias-brand-primary); }
.dshtu-range-row { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; }
.dshtu-range-title { font-size:12px; font-weight:500; }
.dshtu-chart-legend { display:flex; flex-wrap:wrap; gap:4px 12px; margin-bottom:8px; }
.dshtu-legend-item { display:inline-flex; align-items:center; gap:6px; min-width:0; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshtu-legend-name { overflow:hidden; max-width:150px; text-overflow:ellipsis; white-space:nowrap; }
.dshtu-chart-wrap { position:relative; }
.dshtu-chart { display:block; width:100%; height:auto; }
.dshtu-grid-line { stroke:var(--dsw-alias-border-l1); stroke-dasharray:3 3; stroke-width:1; }
.dshtu-axis-label { font-size:10px; fill:var(--dsw-alias-label-secondary); }
.dshtu-line { fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
.dshtu-line-0 { stroke:var(--dsw-alias-brand-primary); }
.dshtu-line-1 { stroke:var(--dsw-alias-state-success-primary); }
.dshtu-line-2 { stroke:var(--dsw-alias-state-warn-primary); }
.dshtu-line-3 { stroke:var(--dsw-alias-state-business-primary); }
.dshtu-line-4 { stroke:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-state-success-primary)); }
.dshtu-line-5 { stroke:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 60%, var(--dsw-alias-state-business-primary)); }
.dshtu-hover-line { stroke:var(--dsw-alias-border-l2); stroke-width:1; }
.dshtu-hover-dot { fill:var(--dsw-alias-bg-layer-1); stroke-width:2; }
.dshtu-tooltip { position:absolute; top:6px; z-index:3; min-width:132px; max-width:220px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-tooltip-bg); color:var(--dsw-alias-label-primary); box-shadow:0 6px 18px var(--dsw-alias-bg-mask-1); pointer-events:none; }
.dshtu-tip-title { margin-bottom:6px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshtu-tip-row { display:flex; align-items:center; gap:6px; font-size:11px; line-height:1.6; }
.dshtu-tip-name { flex:1 1 auto; min-width:0; overflow:hidden; color:var(--dsw-alias-label-secondary); text-overflow:ellipsis; white-space:nowrap; }
.dshtu-tip-value { font-variant-numeric:tabular-nums; }
.dshtu-donut-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:18px; align-items:center; }
.dshtu-donut-wrap { position:relative; width:100%; max-width:230px; margin:0 auto; }
.dshtu-donut { display:block; width:100%; height:auto; }
.dshtu-donut-center { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; pointer-events:none; }
.dshtu-donut-total { font-size:15px; font-weight:600; font-variant-numeric:tabular-nums; }
.dshtu-donut-unit { font-size:10px; color:var(--dsw-alias-label-secondary); }
.dshtu-ring-slice { fill:none; stroke-width:22; }
.dshtu-slice-0 { stroke:var(--dsw-alias-brand-primary); }
.dshtu-slice-1 { stroke:var(--dsw-alias-state-success-primary); }
.dshtu-slice-2 { stroke:var(--dsw-alias-state-warn-primary); }
.dshtu-slice-3 { stroke:var(--dsw-alias-state-business-primary); }
.dshtu-slice-4 { stroke:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-state-success-primary)); }
.dshtu-slice-5 { stroke:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 60%, var(--dsw-alias-state-business-primary)); }
.dshtu-model-list { min-width:0; }
.dshtu-model-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:2px 8px; padding:7px 0; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dshtu-model-row:last-child { border-bottom:none; }
.dshtu-model-name { overflow:hidden; font-family:var(--ds-font-family-code); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.dshtu-model-share { font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dshtu-model-meta { grid-column:2; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshtu-swatch { flex:0 0 auto; width:8px; height:8px; border-radius:2px; }
.dshtu-swatch-0 { background:var(--dsw-alias-brand-primary); }
.dshtu-swatch-1 { background:var(--dsw-alias-state-success-primary); }
.dshtu-swatch-2 { background:var(--dsw-alias-state-warn-primary); }
.dshtu-swatch-3 { background:var(--dsw-alias-state-business-primary); }
.dshtu-swatch-4 { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-state-success-primary)); }
.dshtu-swatch-5 { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 60%, var(--dsw-alias-state-business-primary)); }
.dshtu-empty { padding:22px 8px; border:1px dashed var(--dsw-alias-border-l1); border-radius:10px; color:var(--dsw-alias-label-secondary); font-size:12px; text-align:center; }
.dshtu-error { padding:8px 10px; border-radius:8px; background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color:var(--dsw-alias-state-error-primary); font-size:11px; word-break:break-word; }
.dshtu-note { margin-top:8px; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.5; word-break:break-all; }
.dshtu-note.is-warn { color:var(--dsw-alias-state-warn-primary); }
.dshtu-note.is-ok { color:var(--dsw-alias-state-success-primary); }
.dshtu-banner { display:flex; flex-direction:column; gap:3px; padding:10px 12px; border:1px solid var(--dsw-alias-state-warn-primary); border-radius:10px; background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); font-size:11px; line-height:1.5; }
.dshtu-banner b { font-size:12px; color:var(--dsw-alias-state-warn-primary); }
.dshtu-banner span { color:var(--dsw-alias-label-secondary); }
.dshtu-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:8px; }
.dshtu-foot { color:var(--dsw-alias-label-secondary); font-size:10px; line-height:1.6; word-break:break-all; }
@media (max-width:720px) { .dshtu-donut-grid { grid-template-columns:minmax(0,1fr); } }
@media (max-width:560px) { .dshtu-strip { flex-wrap:wrap; } .dshtu-strip-cell { flex:1 1 45%; } .dshtu-strip-cell + .dshtu-strip-cell { border-left:none; } }
`

    // ---- 格式化：数字 / 日期 / 时长 ----

    /** 当前界面语言：locale 服务会把 <html lang> 同步成 zh-CN / en，读它最省事。 */
    function activeLocale() {
      try {
        const lang = typeof document !== 'undefined' ? document.documentElement?.lang : ''
        if (typeof lang === 'string' && lang !== '') return lang
      } catch {
        /* 无 DOM 时回落到 navigator */
      }
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') return navigator.language
      } catch {
        /* 忽略 */
      }
      return 'en'
    }

    function isZh() {
      return /^zh/i.test(activeLocale())
    }

    // Intl 的格式化器实例化很贵，而热力图一屏要格式化几百个日期与数字：
    // 必须按「语言 + 选项」缓存，否则每次切模式/重渲染都会卡住主线程。
    const numberFormatters = new Map()
    const dateFormatters = new Map()

    function numberFormat(options) {
      const locale = activeLocale()
      const key = `${locale}|${JSON.stringify(options)}`
      let formatter = numberFormatters.get(key)
      if (formatter === undefined) {
        try {
          formatter = new Intl.NumberFormat(locale, options)
        } catch {
          formatter = null
        }
        numberFormatters.set(key, formatter)
      }
      return formatter
    }

    function dateFormat(options) {
      const locale = activeLocale()
      const key = `${locale}|${JSON.stringify(options)}`
      let formatter = dateFormatters.get(key)
      if (formatter === undefined) {
        try {
          formatter = new Intl.DateTimeFormat(locale, options)
        } catch {
          formatter = null
        }
        dateFormatters.set(key, formatter)
      }
      return formatter
    }

    /** 精确整数：调用次数、天数这类不需要缩写。 */
    function formatCount(value) {
      const number = Number(value)
      const safe = Number.isFinite(number) ? Math.round(number) : 0
      const formatter = numberFormat({ maximumFractionDigits: 0 })
      return formatter === null ? String(safe) : formatter.format(safe)
    }

    /** 紧凑 token 数：中文万/亿、英文 K/M/B（与 ZCode 的 compact 口径一致）。 */
    function formatCompact(value) {
      const number = Number(value)
      const safe = Number.isFinite(number) ? number : 0
      const formatter = numberFormat({
        notation: Math.abs(safe) >= 1000 ? 'compact' : 'standard',
        maximumFractionDigits: 1,
        minimumFractionDigits: 0,
      })
      if (formatter === null) return String(Math.round(safe))
      const text = formatter.format(safe)
      // 中文 compact 会把单位直接贴在数字后；摘要里留个空格，和时长、天数对齐。
      return isZh() ? text.replace(/(?<=\d)(?=[万亿])/u, ' ') : text
    }

    function formatPercent(value) {
      const number = Number(value)
      const safe = Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0
      const formatter = numberFormat({ style: 'percent', maximumFractionDigits: safe >= 0.1 ? 0 : 1 })
      return formatter === null ? `${Math.round(safe * 100)}%` : formatter.format(safe)
    }

    function parseDay(dateKey) {
      if (typeof dateKey !== 'string' || dateKey.length < 10) return null
      const date = new Date(`${dateKey.slice(0, 10)}T00:00:00.000Z`)
      return Number.isNaN(date.getTime()) ? null : date
    }

    /** 图表横轴：月/日；热力图 tooltip：完整日期。 */
    function formatDayShort(dateKey) {
      const date = parseDay(dateKey)
      if (date === null) return String(dateKey ?? '')
      const formatter = dateFormat({ month: 'numeric', day: 'numeric', timeZone: 'UTC' })
      return formatter === null ? dateKey : formatter.format(date)
    }

    function formatDayFull(dateKey) {
      const date = parseDay(dateKey)
      if (date === null) return String(dateKey ?? '')
      const formatter = dateFormat({ year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
      return formatter === null ? dateKey : formatter.format(date)
    }

    function formatMonth(dateKey) {
      const date = parseDay(dateKey)
      if (date === null) return ''
      const formatter = dateFormat({ month: 'short', timeZone: 'UTC' })
      return formatter === null ? '' : formatter.format(date)
    }

    /** 模板占位替换：`{date}` 这类短占位比拼字符串更适合双语。 */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
    }

    function formatDuration(ms) {
      const total = Number(ms)
      if (!Number.isFinite(total) || total <= 0) return '—'
      let rest = total
      const parts = []
      for (const unit of DURATION_UNITS) {
        const count = Math.floor(rest / unit.ms)
        if (count > 0) {
          parts.push(`${formatCount(count)} ${t(unit.key)}`)
          rest -= count * unit.ms
        }
      }
      return parts.length === 0 ? `0 ${t('durationMinute')}` : parts.join(' ')
    }

    function formatStamp(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return '—'
      }
    }

    // ---- 图表计算 ----

    function modelLabel(row) {
      if (row?.key === OTHER_KEY) return t('unattributed')
      const name = typeof row?.model === 'string' ? row.model.trim() : ''
      return name === '' ? t('unknownModel') : name
    }

    function levelFor(value, max) {
      if (!(value > 0) || !(max > 0)) return 0
      return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)))
    }

    /** 热力图网格：把 52 周的每日格子按模式换算成「列 × 7 行」的显示数据。 */
    function buildHeatmapColumns(weeks, mode) {
      const weekly = weeks.map((week) => (week.days ?? []).reduce((sum, cell) => sum + (cell?.totalTokens ?? 0), 0))
      const calls = weeks.map((week) => (week.days ?? []).reduce((sum, cell) => sum + (cell?.calls ?? 0), 0))
      const cumulative = []
      let running = 0
      for (const value of weekly) {
        running += value
        cumulative.push(running)
      }
      // 每日和每周/累计的「最大格」不是同一个量纲：混用会让每日视图几乎全是最浅色。
      const maxDaily = weeks.reduce((max, week) => (week.days ?? []).reduce((inner, cell) => Math.max(inner, cell?.totalTokens ?? 0), max), 0)
      const weeklyValues = mode === 'cumulative' ? cumulative : weekly
      const maxWeekly = Math.max(0, ...weeklyValues)
      return weeks.map((week, weekIndex) => {
        const days = week.days ?? []
        const monthDate = monthDateOf(days)
        const lastDate = days.filter(Boolean).at(-1)?.date ?? ''
        if (mode === 'daily') {
          const cells = days.map((cell, dayOffset) => {
            if (cell === null || cell === undefined) return { key: `e-${weekIndex}-${dayOffset}`, level: 0, empty: true, title: undefined }
            return {
              key: cell.date,
              level: levelFor(cell.totalTokens, maxDaily),
              empty: false,
              title: fill(t('heatmapCell'), {
                date: formatDayFull(cell.date),
                tokens: formatCompact(cell.totalTokens),
                calls: formatCount(cell.calls),
              }),
            }
          })
          return { key: `week-${weekIndex}`, monthDate, cells }
        }
        const value = weeklyValues[weekIndex] ?? 0
        const level = levelFor(value, maxWeekly)
        const filled = value <= 0 || maxWeekly <= 0 ? 0 : Math.min(7, Math.max(1, Math.ceil((value / maxWeekly) * 7)))
        const title = fill(t(mode === 'weekly' ? 'heatmapWeeklyCell' : 'heatmapCumulativeCell'), {
          date: formatDayFull(lastDate),
          tokens: formatCompact(value),
          calls: formatCount(calls[weekIndex] ?? 0),
        })
        const cells = days.map((cell, dayOffset) => {
          const on = filled > 0 && dayOffset >= 7 - filled
          return { key: `w-${weekIndex}-${dayOffset}`, level: on ? level : 0, empty: false, title: on || dayOffset === 0 ? title : undefined }
        })
        return { key: `week-${weekIndex}`, monthDate, cells }
      })
    }

    /** 月份的锚点：周列里有 1 号就归到 1 号，否则用周里的第一天。 */
    function monthDateOf(days) {
      const firstOfMonth = days.find((cell) => cell !== null && cell !== undefined && cell.date.endsWith('-01'))
      return firstOfMonth?.date ?? days.filter(Boolean)[0]?.date ?? ''
    }

    function buildMonthLabels(columns) {
      const labels = []
      for (const column of columns) {
        const monthKey = column.monthDate.slice(0, 7)
        const last = labels.at(-1)
        if (last !== undefined && last.key === monthKey) {
          last.span += 1
        } else {
          labels.push({ key: monthKey, label: formatMonth(column.monthDate), span: 1 })
        }
      }
      // 52 周可能横跨 13 个月；保留占位，只隐藏最早那几个的文字，最多显示 12 个。
      const hidden = Math.max(0, labels.length - 12)
      for (let index = 0; index < hidden; index += 1) labels[index].label = ''
      return labels
    }

    /** 折线图数据：只画用量最高的 6 个模型，横轴补齐范围里的每一天。 */
    function buildTrend(snapshot) {
      const days = Array.isArray(snapshot?.dailyModelUsage) ? snapshot.dailyModelUsage : []
      const models = (Array.isArray(snapshot?.models) ? snapshot.models : [])
        .filter((row) => row.totalTokens > 0)
        .slice(0, 6)
      const series = models.map((model, index) => ({
        key: model.key,
        color: index,
        label: modelLabel(model),
      }))
      const rows = days.map((day) => {
        const values = {}
        let total = 0
        for (const entry of day.models ?? []) {
          values[entry.key] = (values[entry.key] ?? 0) + entry.totalTokens
          total += entry.totalTokens
        }
        return { date: day.date, total, values }
      })
      let max = 0
      for (const row of rows) {
        for (const item of series) {
          const value = row.values[item.key] ?? 0
          if (value > max) max = value
        }
      }
      return { series, rows, max }
    }

    /** 环形图切片：前 5 个模型 + 「其他模型」，最多 6 片。 */
    function buildPie(models) {
      const positive = (Array.isArray(models) ? models : []).filter((row) => row.totalTokens > 0)
      const total = positive.reduce((sum, row) => sum + row.totalTokens, 0)
      const limit = positive.length > MAX_PIE_SLICES ? MAX_PIE_SLICES - 1 : MAX_PIE_SLICES
      const slices = positive.slice(0, limit).map((row, index) => ({
        key: row.key,
        color: index,
        label: modelLabel(row),
        totalTokens: row.totalTokens,
        share: total > 0 ? row.totalTokens / total : 0,
      }))
      const rest = positive.slice(limit)
      if (rest.length > 0) {
        const value = rest.reduce((sum, row) => sum + row.totalTokens, 0)
        slices.push({
          key: MERGED_KEY,
          color: limit,
          label: t('otherModel'),
          totalTokens: value,
          share: total > 0 ? value / total : 0,
        })
      }
      return { slices, total }
    }

    // ---- 小组件 ----

    function Tabs({ options, value, onChange }) {
      return h(
        'div',
        { className: 'dshtu-tabs', role: 'tablist' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.key,
              type: 'button',
              role: 'tab',
              'aria-selected': option.key === value,
              className: `dshtu-tab${option.key === value ? ' is-on' : ''}`,
              onClick: () => onChange(option.key),
            },
            option.label,
          ),
        ),
      )
    }

    function EmptyState({ title, description }) {
      return h('div', { className: 'dshtu-empty' }, title, description === undefined ? null : h('div', null, description))
    }

    function Swatch({ index }) {
      return h('i', { className: `dshtu-swatch dshtu-swatch-${index}` })
    }

    // ---- 指标条 ----

    function LifetimeStrip({ summary }) {
      const items = [
        { key: 'total', label: t('lifetimeTotalTokens'), value: summary === null ? '--' : formatCompact(summary.totalTokens) },
        { key: 'peak', label: t('lifetimePeakTokens'), value: summary === null ? '--' : formatCompact(summary.peakDayTokens) },
        { key: 'session', label: t('longestSession'), value: summary === null ? '--' : formatDuration(summary.longestSessionMs) },
        { key: 'current', label: t('currentStreak'), value: summary === null ? '--' : `${formatCount(summary.currentStreakDays)} ${t('durationDay')}` },
        { key: 'longest', label: t('longestStreak'), value: summary === null ? '--' : `${formatCount(summary.longestStreakDays)} ${t('durationDay')}` },
      ]
      return h(
        'section',
        { className: 'dshtu-strip', 'aria-label': t('title') },
        items.map((item) =>
          h(
            'div',
            { className: 'dshtu-strip-cell', key: item.key },
            h('div', { className: 'dshtu-strip-value' }, item.value),
            h('div', { className: 'dshtu-strip-label' }, item.label),
          ),
        ),
      )
    }

    // ---- 热力图 ----

    function HeatmapCard({ heatmap }) {
      const [mode, setMode] = React.useState('daily')
      const weeks = React.useMemo(() => (Array.isArray(heatmap?.weeks) ? heatmap.weeks : []), [heatmap])
      const columns = React.useMemo(() => buildHeatmapColumns(weeks, mode), [weeks, mode])
      const months = React.useMemo(() => buildMonthLabels(columns), [columns])
      if (weeks.length === 0) return null
      const tabs = HEATMAP_MODES.map((option) => ({ key: option, label: t(option === 'daily' ? 'heatmapDaily' : option === 'weekly' ? 'heatmapWeekly' : 'heatmapCumulative') }))

      return h(
        'section',
        { className: 'dshtu-card' },
        h(
          'div',
          { className: 'dshtu-card-head' },
          h('h4', { className: 'dshtu-card-title' }, t('heatmapTitle')),
          h('span', { className: 'dshtu-spacer' }),
          h(Tabs, { options: tabs, value: mode, onChange: setMode }),
        ),
        h(
          'div',
          { className: 'dshtu-heatmap-grid' },
          columns.map((column) =>
            h(
              'div',
              { className: 'dshtu-heatmap-col', key: column.key },
              column.cells.map((cell) =>
                h('div', {
                  key: cell.key,
                  className: `dshtu-heatmap-cell${cell.empty ? ' is-empty' : ''}`,
                  'data-level': String(cell.level),
                  title: cell.title,
                }),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshtu-heatmap-months' },
          months.map((month) => h('div', { key: month.key, className: 'dshtu-month-label', style: { gridColumn: `span ${month.span}` } }, month.label)),
        ),
        h(
          'div',
          { className: 'dshtu-heat-legend' },
          h('span', null, t('heatmapLess')),
          [1, 2, 3, 4].map((level) => h('i', { key: level, className: 'dshtu-heat-legend-cell', 'data-level': String(level) })),
          h('span', null, t('heatmapMore')),
        ),
      )
    }

    // ---- 折线趋势 ----

    const CHART = { width: 640, height: 200, padX: 26, padTop: 12, padBottom: 30 }

    function TrendCard({ snapshot }) {
      const [hover, setHover] = React.useState(-1)
      const trend = React.useMemo(() => buildTrend(snapshot), [snapshot])
      const { series, rows, max } = trend

      let body
      if (max <= 0) {
        body = h(EmptyState, { title: t('emptyTitle'), description: t('emptyRange') })
      } else {
        const plotWidth = CHART.width - CHART.padX * 2
        const plotHeight = CHART.height - CHART.padTop - CHART.padBottom
        const step = rows.length > 1 ? plotWidth / (rows.length - 1) : 0
        const xOf = (index) => CHART.padX + (rows.length > 1 ? index * step : plotWidth / 2)
        const yOf = (value) => CHART.padTop + plotHeight - (Math.max(0, value) / max) * plotHeight
        const labelStep = rows.length <= 14 ? 1 : rows.length > 45 ? 7 : 5
        const children = []
        for (let line = 0; line <= 3; line += 1) {
          const y = CHART.padTop + (plotHeight / 3) * line
          children.push(h('line', { key: `grid-${line}`, className: 'dshtu-grid-line', x1: CHART.padX, x2: CHART.width - CHART.padX, y1: y, y2: y }))
        }
        for (const item of series) {
          let path = ''
          for (let index = 0; index < rows.length; index += 1) {
            const value = rows[index].values[item.key] ?? 0
            path += `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`
          }
          children.push(h('path', { key: `line-${item.key}`, className: `dshtu-line dshtu-line-${item.color}`, d: path }))
        }
        rows.forEach((row, index) => {
          const showLabel = rows.length <= 14 ? true : index === 0 || index === rows.length - 1 || index % labelStep === 0
          if (showLabel) {
            children.push(
              h('text', {
                key: `label-${row.date}`,
                className: 'dshtu-axis-label',
                x: xOf(index),
                y: CHART.height - 10,
                textAnchor: 'middle',
              }, formatDayShort(row.date)),
            )
          }
        })
        if (hover >= 0 && hover < rows.length) {
          const row = rows[hover]
          children.push(h('line', { key: 'hover-line', className: 'dshtu-hover-line', x1: xOf(hover), x2: xOf(hover), y1: CHART.padTop, y2: CHART.padTop + plotHeight }))
          for (const item of series) {
            const value = row.values[item.key] ?? 0
            if (value <= 0) continue
            children.push(h('circle', { key: `dot-${item.key}`, className: `dshtu-hover-dot dshtu-line-${item.color}`, cx: xOf(hover), cy: yOf(value), r: 4 }))
          }
        }
        // 透明热区：每一列一个矩形，悬停只改 index，不做坐标换算，移动端也稳。
        for (let index = 0; index < rows.length; index += 1) {
          const width = plotWidth / Math.max(1, rows.length - 1)
          children.push(
            h('rect', {
              key: `hit-${index}`,
              x: xOf(index) - width / 2,
              y: CHART.padTop,
              width,
              height: plotHeight,
              fill: 'transparent',
              onMouseEnter: () => setHover(index),
              onMouseLeave: () => setHover(-1),
            }),
          )
        }

        const hoveredRow = hover >= 0 && hover < rows.length ? rows[hover] : null
        const tooltip =
          hoveredRow === null
            ? null
            : h(
                'div',
                {
                  className: 'dshtu-tooltip',
                  style: {
                    left: `${(xOf(hover) / CHART.width) * 100}%`,
                    transform: hover < 2 ? 'translateX(0)' : hover > rows.length - 3 ? 'translateX(-100%)' : 'translateX(-50%)',
                  },
                },
                h('div', { className: 'dshtu-tip-title' }, `${formatDayShort(hoveredRow.date)} · ${formatCompact(hoveredRow.total)} ${t('tokenUnit')}`),
                series
                  .filter((item) => (hoveredRow.values[item.key] ?? 0) > 0)
                  .sort((left, right) => (hoveredRow.values[right.key] ?? 0) - (hoveredRow.values[left.key] ?? 0))
                  .map((item) =>
                    h(
                      'div',
                      { className: 'dshtu-tip-row', key: item.key },
                      h(Swatch, { index: item.color }),
                      h('span', { className: 'dshtu-tip-name' }, item.label),
                      h('span', { className: 'dshtu-tip-value' }, formatCompact(hoveredRow.values[item.key] ?? 0)),
                    ),
                  ),
              )

        body = h(
          'div',
          { className: 'dshtu-chart-wrap' },
          h(
            'svg',
            {
              className: 'dshtu-chart',
              viewBox: `0 0 ${CHART.width} ${CHART.height}`,
              role: 'img',
              'aria-label': t('dailyChartTitle'),
            },
            children,
          ),
          tooltip,
        )
      }

      return h(
        'section',
        { className: 'dshtu-card' },
        h('div', { className: 'dshtu-card-head' }, h('h4', { className: 'dshtu-card-title' }, t('dailyChartTitle'))),
        max <= 0
          ? null
          : h(
              'div',
              { className: 'dshtu-chart-legend' },
              series.map((item) =>
                h(
                  'span',
                  { className: 'dshtu-legend-item', key: item.key },
                  h(Swatch, { index: item.color }),
                  h('span', { className: 'dshtu-legend-name', title: item.label }, item.label),
                ),
              ),
            ),
        body,
      )
    }

    // ---- 模型环形图 ----

    const DONUT = { size: 180, radius: 70, width: 22 }

    function ModelCard({ snapshot }) {
      const { slices, total } = React.useMemo(() => buildPie(snapshot?.models), [snapshot])
      const center = DONUT.size / 2
      const circumference = 2 * Math.PI * DONUT.radius
      const gap = slices.length > 1 ? 2 : 0
      let offset = 0
      const rings = slices.map((slice) => {
        const length = slice.share * circumference
        const dash = Math.max(0, length - gap)
        const ring = h('circle', {
          key: slice.key,
          className: `dshtu-ring-slice dshtu-slice-${slice.color}`,
          cx: center,
          cy: center,
          r: DONUT.radius,
          strokeWidth: DONUT.width,
          strokeDasharray: `${dash} ${circumference - dash}`,
          strokeDashoffset: -offset,
          transform: `rotate(-90 ${center} ${center})`,
        })
        offset += length
        return ring
      })

      return h(
        'section',
        { className: 'dshtu-card' },
        h('div', { className: 'dshtu-card-head' }, h('h4', { className: 'dshtu-card-title' }, t('modelChartTitle'))),
        total <= 0
          ? h(EmptyState, { title: t('emptyTitle'), description: t('emptyRange') })
          : h(
              'div',
              { className: 'dshtu-donut-grid' },
              h(
                'div',
                { className: 'dshtu-donut-wrap' },
                h(
                  'svg',
                  { className: 'dshtu-donut', viewBox: `0 0 ${DONUT.size} ${DONUT.size}`, role: 'img', 'aria-label': t('modelChartTitle') },
                  h('circle', { cx: center, cy: center, r: DONUT.radius, fill: 'none', stroke: 'var(--dsw-alias-border-l1)', strokeWidth: DONUT.width }),
                  rings,
                ),
                h(
                  'div',
                  { className: 'dshtu-donut-center' },
                  h('div', { className: 'dshtu-donut-total' }, formatCompact(total)),
                  h('div', { className: 'dshtu-donut-unit' }, t('tokenUnit')),
                ),
              ),
              h(
                'div',
                { className: 'dshtu-model-list' },
                slices.map((slice) =>
                  h(
                    'div',
                    { className: 'dshtu-model-row', key: slice.key },
                    h(Swatch, { index: slice.color }),
                    h('span', { className: 'dshtu-model-name', title: slice.label }, slice.label),
                    h('span', { className: 'dshtu-model-share' }, formatPercent(slice.share)),
                    h('span', { className: 'dshtu-model-meta' }, `${formatCompact(slice.totalTokens)} ${t('tokenUnit')}`),
                  ),
                ),
              ),
            ),
      )
    }

    // ---- 页面 ----

    function UsageSection() {
      const [range, setRange] = React.useState('7d')
      const [lifetime, setLifetime] = React.useState(null)
      const [ranged, setRanged] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [tick, setTick] = React.useState(0)
      const [flash, setFlash] = React.useState(null)

      const accept = (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      }

      const read = React.useCallback((target) => {
        return fetch(`${STATS_PATH}?range=${target}`, { headers: { accept: 'application/json' } }).then(accept)
      }, [])

      React.useEffect(() => {
        let cancelled = false
        read('all')
          .then((payload) => {
            if (!cancelled) {
              setLifetime(payload)
              setError(null)
            }
          })
          .catch((cause) => {
            if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
          })
        return () => {
          cancelled = true
        }
      }, [read, tick])

      React.useEffect(() => {
        let cancelled = false
        setBusy(true)
        read(range)
          .then((payload) => {
            if (!cancelled) {
              setRanged(payload)
              setError(null)
            }
          })
          .catch((cause) => {
            if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
          })
          .finally(() => {
            if (!cancelled) setBusy(false)
          })
        return () => {
          cancelled = true
        }
      }, [read, range, tick])

      React.useEffect(() => {
        if (flash === null) return undefined
        const timer = setTimeout(() => setFlash(null), 2400)
        return () => clearTimeout(timer)
      }, [flash])

      const refresh = () => setTick((value) => value + 1)

      const reset = () => {
        if (typeof window.confirm === 'function' && !window.confirm(t('confirmReset'))) return
        setBusy(true)
        fetch(RESET_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          .then(accept)
          .then(() => {
            setFlash('reset')
            setTick((value) => value + 1)
            setError(null)
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }

      const head = h(
        'div',
        { className: 'dshtu-head', key: 'head' },
        h('h3', { className: 'dshtu-title' }, t('title')),
        h('span', { className: 'dshtu-live' }, h('i', { className: 'dshtu-dot' }), t('live')),
        h('span', { className: 'dshtu-spacer' }),
        flash === 'reset' ? h('span', { className: 'dshtu-ok' }, t('resetDone')) : null,
      )

      const staleBanner =
        typeof lifetime?.staleSince === 'number'
          ? h('div', { className: 'dshtu-banner', key: 'stale' }, h('b', null, t('staleTitle')), h('span', null, t('staleHint')))
          : null

      const errorNode = error === null ? null : h('div', { className: 'dshtu-error', key: 'error' }, `${t('failed')}${error}`)

      if (lifetime === null) {
        return h(
          'div',
          { className: 'dshtu-root' },
          h('style', { key: 'style' }, CSS),
          head,
          staleBanner,
          errorNode,
          error === null ? h('div', { className: 'dshtu-empty', key: 'loading' }, t('loading')) : null,
        )
      }

      const notices = [
        lifetime.corruptBackup ? h('div', { className: 'dshtu-note is-warn', key: 'corrupt' }, `${t('corruptBackup')} ${lifetime.corruptBackup}`) : null,
        lifetime.restoredFrom ? h('div', { className: 'dshtu-note is-ok', key: 'restored' }, `${t('restoredFrom')} ${lifetime.restoredFrom}`) : null,
        lifetime.resetBackup ? h('div', { className: 'dshtu-note', key: 'reset' }, `${t('resetBackup')} ${lifetime.resetBackup}`) : null,
      ].filter(Boolean)

      const empty = (lifetime.summary?.totalTokens ?? 0) <= 0
      const rangeTabs = RANGE_OPTIONS.map((option) => ({ key: option, label: t(option === '7d' ? 'range7d' : 'range30d') }))

      return h(
        'div',
        { className: 'dshtu-root' },
        h('style', { key: 'style' }, CSS),
        head,
        staleBanner,
        errorNode,
        h(LifetimeStrip, { key: 'strip', summary: lifetime.summary ?? null }),
        empty ? null : h(HeatmapCard, { key: 'heatmap', heatmap: lifetime.heatmap }),
        h(
          'div',
          { className: 'dshtu-range-row', key: 'range' },
          h('span', { className: 'dshtu-range-title' }, t('rangeTitle')),
          h(Tabs, { options: rangeTabs, value: range, onChange: (value) => setRange(value) }),
        ),
        h(TrendCard, { key: 'trend', snapshot: ranged ?? lifetime }),
        h(ModelCard, { key: 'models', snapshot: ranged ?? lifetime }),
        h(
          'div',
          { className: 'dshtu-actions', key: 'actions' },
          h('button', { className: 'dshtu-btn', type: 'button', disabled: busy, onClick: reset }, t('reset')),
          h('button', { className: 'dshtu-btn is-primary', type: 'button', disabled: busy, onClick: refresh }, t('refresh')),
        ),
        ...notices,
        h(
          'div',
          { className: 'dshtu-foot', key: 'foot' },
          `${t('file')}：${lifetime.file ?? '—'} · ${t('since')} ${formatStamp(lifetime.since)} · ${t('updated')} ${formatStamp(lifetime.updatedAt)} · ${t('build')} ${lifetime.build ?? '—'}`,
        ),
      )
    }

    function apply(ctx) {
      t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'token-usage: dictionaries')
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'token-usage',
            order: 30,
            label: () => t('nav'),
            locale: NS,
          },
          UsageSection,
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
