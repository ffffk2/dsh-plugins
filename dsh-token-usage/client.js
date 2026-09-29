/**
 * Token 统计 —— Client 半。
 *
 * 设置面板里的一个 `settings.section` 页面，做成仪表盘：
 *   ① 主视觉：总 Token（渐变数字 + 滚动动画）+ 缓存命中率圆环
 *   ② 构成条：输入 / 输出 / 缓存命中（+ 缓存写入、推理，有值才出现）堆叠占比
 *   ③ 费用卡：总费用（¥）+ 已定价模型数 + 单价编辑表
 *   ④ 趋势图：近 7 / 14 / 30 天柱状图，逐根生长动画，悬停看具体数值
 *   ⑤ 按模型表：列自适应（全为 0 的列不出现）+ 每行占比条 + 该模型费用
 *   ⑥ 按天表：默认 7 行，可展开到全部
 *
 * 数据来自同包 Host 半的 GET /token-usage/stats；清零走 POST /token-usage/reset；
 * 单价读写走 GET/POST /token-usage/prices。
 * 只用宿主主题 token（--dsw-alias-*）着色，不引入任何 Harness Client 包。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-token-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'token-usage'
    const STATS_PATH = '/token-usage/stats'
    const RESET_PATH = '/token-usage/reset'
    const PRICES_PATH = '/token-usage/prices'
    const RINGS = { size: 88, radius: 34, width: 8 }
    /** 单价单位：人民币元 / 百万 token（与 Host 半一致）。 */
    const PER_TOKENS = 1_000_000
    /** 计费项顺序，zh/en 的 label 键与 Host 返回的 cost.items 字段同名。 */
    const PRICE_FIELDS = [
      { field: 'input', label: 'input' },
      { field: 'output', label: 'output' },
      { field: 'cacheRead', label: 'cacheRead' },
      { field: 'cacheWrite', label: 'cacheWrite' },
    ]

    const zh = {
      nav: 'Token 统计',
      title: '模型 Token 累计',
      live: '实时记录中',
      total: '总 Token',
      perCall: '平均每次',
      calls: '调用次数',
      breakdown: 'Token 构成',
      input: '输入',
      output: '输出',
      cacheRead: '缓存命中',
      cacheWrite: '缓存写入',
      reasoning: '推理',
      cacheHitRate: '缓存命中率',
      trend: '消耗趋势',
      dayUnit: '天',
      byModel: '按模型',
      byDay: '按天',
      model: '模型',
      day: '日期',
      share: '占比',
      refresh: '刷新',
      reset: '清零',
      confirmReset: '确定清零累计统计吗？此操作不可撤销。单价设置会保留。',
      loading: '加载中…',
      empty: '暂无记录。发出任意一次模型对话后回到这里即可看到累计。',
      file: '数据文件',
      since: '统计起始',
      updated: '最近更新',
      failed: '读取失败：',
      expand: '展开全部',
      collapse: '收起',
      cost: '费用',
      costTitle: '费用估算',
      totalCost: '总费用',
      costNote: '按你在下方填写的单价估算，仅供参考；未定价的模型不计入。',
      priced: '已定价',
      unpriced: '未定价',
      partialPrice: '单价不全',
      priceTitle: '模型单价',
      priceHint: '单位：元 / 百万 token。留空表示不计算该项，全部留空即该模型不计费。',
      priceUnit: '/ 百万 token',
      save: '保存单价',
      saving: '保存中…',
      saved: '单价已保存',
      resetPrices: '清空单价',
      confirmResetPrices: '确定清空所有模型单价吗？',
      priceInput: '输入单价',
      priceOutput: '输出单价',
      priceCacheRead: '缓存命中单价',
      priceCacheWrite: '缓存写入单价',
      costInput: '输入费用',
      costOutput: '输出费用',
      costCacheRead: '缓存命中费用',
      costCacheWrite: '缓存写入费用',
      priceEmpty: '还没有任何模型记录。先发起一次对话，这里就能给模型填单价了。',
      priceDirty: '有未保存的修改',
      priceSavedAt: '单价更新于',
      corruptBackup: '上次启动时累计文件损坏，已备份到',
      restoredFrom: '已从快照恢复累计：',
      resetBackup: '清零前的数据已快照保存：',
      resetDone: '已清零',
      staleTitle: '正在运行的是旧版插件代码',
      staleHint: '磁盘上的 index.js 已更新，但 DSH 仍在使用启动时加载的版本（Node 会缓存已导入的模块）。请完全退出并重启 DSH Desktop，否则新功能不会生效。',
      build: '代码版本',
    }

    const en = {
      nav: 'Token Usage',
      title: 'Model token totals',
      live: 'Recording',
      total: 'Total tokens',
      perCall: 'Per call',
      calls: 'Calls',
      breakdown: 'Composition',
      input: 'Input',
      output: 'Output',
      cacheRead: 'Cache read',
      cacheWrite: 'Cache write',
      reasoning: 'Reasoning',
      cacheHitRate: 'Cache hit rate',
      trend: 'Daily trend',
      dayUnit: 'd',
      byModel: 'By model',
      byDay: 'By day',
      model: 'Model',
      day: 'Date',
      share: 'Share',
      refresh: 'Refresh',
      reset: 'Reset',
      confirmReset: 'Reset all accumulated token usage? This cannot be undone. Your prices are kept.',
      loading: 'Loading…',
      empty: 'No records yet. Send one model message and come back.',
      file: 'Data file',
      since: 'Counting since',
      updated: 'Last updated',
      failed: 'Load failed: ',
      expand: 'Show all',
      collapse: 'Collapse',
      cost: 'Cost',
      costTitle: 'Estimated cost',
      totalCost: 'Total cost',
      costNote: 'Estimated from the prices you enter below. Models without a price are excluded.',
      priced: 'Priced',
      unpriced: 'No price',
      partialPrice: 'Partial price',
      priceTitle: 'Model prices',
      priceHint: 'Unit: CNY per million tokens. Leave a field empty to skip it; leave all empty to exclude the model.',
      priceUnit: '/ 1M tokens',
      save: 'Save prices',
      saving: 'Saving…',
      saved: 'Prices saved',
      resetPrices: 'Clear prices',
      confirmResetPrices: 'Clear all model prices?',
      priceInput: 'Input price',
      priceOutput: 'Output price',
      priceCacheRead: 'Cache read price',
      priceCacheWrite: 'Cache write price',
      costInput: 'Input cost',
      costOutput: 'Output cost',
      costCacheRead: 'Cache read cost',
      costCacheWrite: 'Cache write cost',
      priceEmpty: 'No model recorded yet. Send one message first, then set prices here.',
      priceDirty: 'Unsaved changes',
      priceSavedAt: 'Prices updated',
      corruptBackup: 'The totals file was corrupt at last startup; backed up to',
      restoredFrom: 'Totals restored from snapshot:',
      resetBackup: 'The data cleared by reset was snapshotted to:',
      resetDone: 'Cleared',
      staleTitle: 'An older build of the plugin is running',
      staleHint: 'index.js on disk is newer, but DSH still uses the version loaded at startup (Node caches imported modules). Fully quit and restart DSH Desktop, or the new behaviour will not apply.',
      build: 'Build',
    }

    // 由 apply 绑定的翻译函数；组件渲染时读取。
    let t = (key) => key

    /** 构成条的固定段：推理通常已含在输出里，所以只入图例、不入堆叠。 */
    const SEGMENTS = [
      { key: 'inputTokens', label: 'input', tone: 'brand' },
      { key: 'outputTokens', label: 'output', tone: 'success' },
      { key: 'cacheReadTokens', label: 'cacheRead', tone: 'warn' },
      { key: 'cacheWriteTokens', label: 'cacheWrite', tone: 'idle' },
    ]

    const CSS = `
.dshtu-root { display:flex; flex-direction:column; gap:12px; color:var(--dsw-alias-label-primary); font-size:13px; }
.dshtu-root *, .dshtu-root *::before, .dshtu-root *::after { box-sizing:border-box; }

.dshtu-head { display:flex; align-items:center; gap:8px; }
.dshtu-title { margin:0; font-size:14px; font-weight:600; }
.dshtu-spacer { flex:1 1 auto; }
.dshtu-live { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshtu-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); animation:dshtu-pulse 1.8s ease-in-out infinite; }
@keyframes dshtu-pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.35; transform:scale(.7); } }

.dshtu-btn { height:26px; padding:0 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-secondary); font-size:12px; cursor:pointer; transition:color .15s, border-color .15s, background-color .15s; }
.dshtu-btn:hover:not([disabled]) { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dshtu-btn[disabled] { opacity:.45; cursor:default; }
.dshtu-btn.is-on { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-1); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.dshtu-seg { display:inline-flex; gap:2px; padding:2px; border-radius:9px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); }
.dshtu-seg .dshtu-btn { height:22px; border-color:transparent; }

.dshtu-card { position:relative; overflow:hidden; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-2); padding:14px 16px; animation:dshtu-rise .4s cubic-bezier(.22,1,.36,1) both; }
@keyframes dshtu-rise { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
.dshtu-card::before { content:''; position:absolute; inset:0 0 auto 0; height:1px; background:linear-gradient(90deg, transparent, var(--dsw-alias-border-l2), transparent); background:linear-gradient(90deg, transparent, color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent), transparent); }
.dshtu-hero { display:flex; align-items:center; gap:16px; }
.dshtu-hero-main { flex:1 1 auto; min-width:0; }
.dshtu-eyebrow { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--dsw-alias-label-secondary); }
.dshtu-total { margin:2px 0 6px; font-size:32px; line-height:1.1; font-weight:700; font-variant-numeric:tabular-nums; background:linear-gradient(96deg, var(--dsw-alias-brand-primary), var(--dsw-alias-state-success-primary)); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:var(--dsw-alias-brand-primary); }
.dshtu-sub { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshtu-sub b { color:var(--dsw-alias-label-primary); font-weight:600; font-variant-numeric:tabular-nums; }

.dshtu-ring { position:relative; flex:0 0 auto; width:88px; height:88px; }
.dshtu-ring svg { display:block; transform:rotate(-90deg); }
.dshtu-ring-track { fill:none; stroke:var(--dsw-alias-border-l1); stroke-width:8; }
.dshtu-ring-value { fill:none; stroke:var(--dsw-alias-brand-primary); stroke-width:8; stroke-linecap:round; transition:stroke-dashoffset .7s cubic-bezier(.22,1,.36,1); }
.dshtu-ring-text { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; }
.dshtu-ring-num { font-size:16px; font-weight:700; font-variant-numeric:tabular-nums; }
.dshtu-ring-cap { font-size:9px; color:var(--dsw-alias-label-secondary); text-align:center; line-height:1.1; }

.dshtu-stack { display:flex; gap:2px; height:12px; border-radius:6px; overflow:hidden; background:var(--dsw-alias-bg-base); }
.dshtu-fill { transform-origin:left center; animation:dshtu-fill .55s cubic-bezier(.22,1,.36,1) both; }
@keyframes dshtu-fill { from { transform:scaleX(0); } to { transform:scaleX(1); } }
.dshtu-legend { display:flex; flex-wrap:wrap; gap:6px 18px; margin-top:10px; }
.dshtu-legend-item { display:flex; align-items:baseline; gap:6px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshtu-legend-item b { font-size:13px; color:var(--dsw-alias-label-primary); font-variant-numeric:tabular-nums; }
.dshtu-swatch { width:8px; height:8px; border-radius:3px; flex:0 0 auto; align-self:center; }
.dshtu-tone-brand { background:var(--dsw-alias-brand-primary); }
.dshtu-tone-success { background:var(--dsw-alias-state-success-primary); }
.dshtu-tone-warn { background:var(--dsw-alias-state-warn-primary); }
.dshtu-tone-idle { background:var(--dsw-alias-state-idle-primary); }
.dshtu-tone-muted { background:var(--dsw-alias-border-l2); }

.dshtu-section-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.dshtu-section-title { margin:0; font-size:12px; font-weight:600; }
.dshtu-count { font-size:11px; color:var(--dsw-alias-label-secondary); }

.dshtu-chart { width:100%; height:auto; display:block; }
.dshtu-bar { transform-box:fill-box; transform-origin:bottom; animation:dshtu-grow .5s cubic-bezier(.22,1,.36,1) both; }
@keyframes dshtu-grow { from { transform:scaleY(0); } to { transform:scaleY(1); } }
.dshtu-bar-base { fill:var(--dsw-alias-border-l2); }
.dshtu-bar-fill { fill:var(--dsw-alias-brand-primary); fill:color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); }
.dshtu-bar-today { fill:var(--dsw-alias-brand-primary); }
.dshtu-bar-peak { fill:var(--dsw-alias-state-success-primary); }
.dshtu-tick { font-size:9px; fill:var(--dsw-alias-label-secondary); }
.dshtu-axis { stroke:var(--dsw-alias-border-l1); stroke-width:1; }

.dshtu-table-wrap { overflow-x:auto; }
.dshtu-table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
.dshtu-table th { text-align:right; font-weight:500; font-size:11px; color:var(--dsw-alias-label-secondary); padding:5px 6px; border-bottom:1px solid var(--dsw-alias-border-l1); white-space:nowrap; }
.dshtu-table td { text-align:right; padding:6px; border-bottom:1px solid var(--dsw-alias-border-l1); white-space:nowrap; }
.dshtu-table th:first-child, .dshtu-table td:first-child { text-align:left; width:100%; }
.dshtu-table tbody tr:hover td { background:var(--dsw-alias-bg-layer-2); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent); }
.dshtu-table tbody tr:last-child td { border-bottom:none; }
.dshtu-model { display:flex; flex-direction:column; gap:3px; min-width:0; }
.dshtu-model-name { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshtu-model-meta { display:flex; align-items:center; gap:6px; }
.dshtu-badge { font-size:9px; padding:0 5px; height:14px; line-height:14px; border-radius:7px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); }
.dshtu-share { flex:1 1 auto; height:3px; min-width:24px; border-radius:2px; background:var(--dsw-alias-bg-base); overflow:hidden; }
.dshtu-share > i { display:block; height:100%; background:var(--dsw-alias-brand-primary); transform-origin:left center; animation:dshtu-fill .55s cubic-bezier(.22,1,.36,1) both; }
.dshtu-empty { font-size:12px; color:var(--dsw-alias-label-secondary); }
.dshtu-error { font-size:12px; color:var(--dsw-alias-state-error-primary); }
.dshtu-foot { font-size:11px; color:var(--dsw-alias-label-secondary); word-break:break-all; }

/* 费用 */
.dshtu-money { font-variant-numeric:tabular-nums; }
.dshtu-cost-main { display:flex; align-items:flex-end; gap:8px; }
.dshtu-cost-num { font-size:28px; line-height:1.1; font-weight:700; font-variant-numeric:tabular-nums; color:var(--dsw-alias-state-success-primary); }
.dshtu-cost-num.is-unknown { color:var(--dsw-alias-label-secondary); font-size:20px; }
.dshtu-cost-unit { font-size:11px; color:var(--dsw-alias-label-secondary); padding-bottom:4px; }
.dshtu-cost-body { display:flex; flex-wrap:wrap; gap:12px 28px; margin-top:10px; }
.dshtu-cost-item { display:flex; flex-direction:column; gap:2px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshtu-cost-item b { font-size:13px; color:var(--dsw-alias-label-primary); font-variant-numeric:tabular-nums; }
.dshtu-cost-item i { font-style:normal; font-size:10px; color:var(--dsw-alias-label-secondary); }
.dshtu-note { margin-top:10px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshtu-warn { color:var(--dsw-alias-state-warn-primary); }
.dshtu-ok { color:var(--dsw-alias-state-success-primary); }

/* 单价编辑 */
.dshtu-price-input { width:88px; height:24px; padding:0 6px; border-radius:6px; font-size:12px; font-variant-numeric:tabular-nums; text-align:right; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.dshtu-price-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.dshtu-price-input::placeholder { color:var(--dsw-alias-label-secondary); }
.dshtu-price-unit { margin-left:4px; font-size:10px; color:var(--dsw-alias-label-secondary); }
.dshtu-price-cell { display:flex; align-items:center; justify-content:flex-end; }
.dshtu-actions { display:flex; align-items:center; gap:8px; margin-top:10px; flex-wrap:wrap; }
.dshtu-btn.is-primary { color:var(--dsw-alias-bg-base); border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-brand-primary); }
.dshtu-btn.is-primary:hover:not([disabled]) { color:var(--dsw-alias-bg-base); opacity:.86; }

/* 旧代码横幅：不是报错，是「你改的东西还没生效」，所以用警示色而非错误色 */
.dshtu-banner { display:flex; flex-direction:column; gap:3px; padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-state-warn-primary); background:var(--dsw-alias-bg-layer-2); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); font-size:11px; line-height:1.5; }
.dshtu-banner b { font-size:12px; color:var(--dsw-alias-state-warn-primary); }
.dshtu-banner span { color:var(--dsw-alias-label-secondary); }
`

    function formatNumber(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
      return number.toLocaleString()
    }

    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return '—'
      }
    }

    /**
     * 金额格式化：小额多留几位，避免 ¥0.00 看不出差别。
     * @param value - 金额（元）。
     */
    function formatMoney(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (number === 0) return '0.00'
      const abs = Math.abs(number)
      const digits = abs < 0.01 ? 4 : 2
      return number.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    }

    /** 单价复用金额格式：填了 0 就显示 0，留空由调用方处理。 */
    function formatRate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      return String(value)
    }

    /** 从一行模型统计里取费用对象（Host 未返回时给一个全 0 的兜底）。 */
    function costOf(row) {
      const cost = row?.cost
      if (cost !== null && typeof cost === 'object') return cost
      return { known: false, partial: false, total: 0, items: {} }
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** 最近 n 个本地自然日的 key，升序。 */
    function recentDayKeys(n) {
      const keys = []
      const now = new Date()
      for (let offset = n - 1; offset >= 0; offset -= 1) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)
        keys.push(`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`)
      }
      return keys
    }

    /** 把 /stats 的按天数组补成连续 n 天，升序。 */
    function buildSeries(days, n) {
      const byDay = new Map()
      for (const row of days) byDay.set(row.day, row)
      return recentDayKeys(n).map((day) => ({ day, row: byDay.get(day) ?? null, value: byDay.get(day)?.totalTokens ?? 0 }))
    }

    /** 从 0 滚到目标值的数字动画。 */
    function useCountUp(value) {
      const target = typeof value === 'number' && Number.isFinite(value) ? value : 0
      const [display, setDisplay] = React.useState(target)
      const fromRef = React.useRef(target)
      React.useEffect(() => {
        const from = fromRef.current
        if (from === target) return undefined
        let frame = 0
        const started = Date.now()
        const step = () => {
          const progress = Math.min(1, (Date.now() - started) / 600)
          const eased = 1 - Math.pow(1 - progress, 3)
          setDisplay(from + (target - from) * eased)
          if (progress < 1) frame = requestAnimationFrame(step)
          else fromRef.current = target
        }
        frame = requestAnimationFrame(step)
        return () => cancelAnimationFrame(frame)
      }, [target])
      return display
    }

    /** 挂载后翻一次，让圆环/进度条从 0 过渡到真实值。 */
    function useMounted() {
      const [mounted, setMounted] = React.useState(false)
      React.useEffect(() => {
        const frame = requestAnimationFrame(() => setMounted(true))
        return () => cancelAnimationFrame(frame)
      }, [])
      return mounted
    }

    function CacheRing({ ratio, mounted }) {
      const { size, radius, width } = RINGS
      const center = size / 2
      const circumference = 2 * Math.PI * radius
      const safe = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
      const offset = mounted ? circumference * (1 - safe) : circumference
      return h(
        'div',
        { className: 'dshtu-ring' },
        h(
          'svg',
          { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true },
          h('circle', { className: 'dshtu-ring-track', cx: center, cy: center, r: radius, strokeWidth: width }),
          h('circle', {
            className: 'dshtu-ring-value',
            cx: center,
            cy: center,
            r: radius,
            strokeWidth: width,
            strokeDasharray: circumference,
            strokeDashoffset: offset,
          }),
        ),
        h(
          'div',
          { className: 'dshtu-ring-text' },
          h('span', { className: 'dshtu-ring-num' }, `${Math.round(safe * 100)}%`),
          h('span', { className: 'dshtu-ring-cap' }, t('cacheHitRate')),
        ),
      )
    }

    function TrendChart({ series, range }) {
      const width = 600
      const plot = 100
      const slot = width / series.length
      const barWidth = Math.max(3, Math.min(slot * 0.56, 30))
      const peak = series.reduce((max, item) => (item.value > max ? item.value : max), 0)
      const safePeak = peak > 0 ? peak : 1
      const stride = Math.ceil(series.length / 14)
      const lastIndex = series.length - 1
      const children = [
        h('line', { key: 'axis', className: 'dshtu-axis', x1: 0, y1: plot, x2: width, y2: plot }),
      ]
      series.forEach((item, index) => {
        const height = item.value > 0 ? Math.max(2, (item.value / safePeak) * (plot - 8)) : 0
        const x = index * slot + (slot - barWidth) / 2
        const isToday = index === lastIndex
        const tone = item.value === 0 ? 'dshtu-bar-base' : isToday ? 'dshtu-bar-today' : item.value === peak ? 'dshtu-bar-peak' : 'dshtu-bar-fill'
        children.push(
          h(
            'g',
            { key: item.day },
            h('rect', {
              className: `dshtu-bar ${tone}`,
              style: { animationDelay: `${Math.min(index * 18, 320)}ms` },
              x,
              y: item.value === 0 ? plot - 2 : plot - height,
              width: barWidth,
              height: item.value === 0 ? 2 : height,
              rx: item.value === 0 ? 1 : Math.min(3, barWidth / 2),
            }),
            h('title', null, `${item.day} · ${formatNumber(item.value)} / ${item.row ? formatNumber(item.row.calls) : 0} ${t('calls')}`),
          ),
        )
        if (index % stride === 0 || isToday) {
          children.push(
            h(
              'text',
              { key: `${item.day}-tick`, className: 'dshtu-tick', x: x + barWidth / 2, y: plot + 14, textAnchor: 'middle' },
              item.day.slice(8),
            ),
          )
        }
      })
      return h('svg', { className: 'dshtu-chart', viewBox: `0 0 ${width} ${plot + 20}`, role: 'img', 'aria-label': `${t('trend')} ${range}${t('dayUnit')}` }, children)
    }

    /** 费用卡：总费用 + 四个计费项明细 + 未定价提示。 */
    function CostCard({ data, models }) {
      const totalCost = typeof data.totalCost === 'number' ? data.totalCost : 0
      const priced = models.filter((row) => costOf(row).known)
      const unpriced = models.filter((row) => !costOf(row).known)
      // 明细按「所有已定价模型」逐项求和，而不是用总额推，口径才和按模型表一致。
      const items = PRICE_FIELDS.map(({ field, label }) => {
        let cost = 0
        let tokens = 0
        for (const row of priced) {
          const item = costOf(row).items?.[field]
          cost += item?.cost ?? 0
          tokens += item?.tokens ?? row[`${field}Tokens`] ?? 0
        }
        return { field, label, cost, tokens }
      })
      const hasCost = priced.length > 0

      return h(
        'div',
        { className: 'dshtu-card' },
        h(
          'div',
          { className: 'dshtu-section-head' },
          h('h4', { className: 'dshtu-section-title' }, t('costTitle')),
          h('span', { className: 'dshtu-spacer' }),
          h(
            'span',
            { className: 'dshtu-count' },
            `${t('priced')} ${priced.length} / ${models.length}`,
          ),
        ),
        h(
          'div',
          { className: 'dshtu-cost-main' },
          h(
            'span',
            { className: `dshtu-cost-num${hasCost ? '' : ' is-unknown'}` },
            hasCost ? `¥${formatMoney(totalCost)}` : t('unpriced'),
          ),
          hasCost ? h('span', { className: 'dshtu-cost-unit' }, 'CNY') : null,
        ),
        hasCost
          ? h(
              'div',
              { className: 'dshtu-cost-body' },
              items.map((item) =>
                h(
                  'div',
                  { className: 'dshtu-cost-item', key: item.field },
                  h('span', null, t(item.label)),
                  h('b', null, `¥${formatMoney(item.cost)}`),
                  h('i', null, `${formatNumber(item.tokens)} tok`),
                ),
              ),
            )
          : null,
        h('div', { className: 'dshtu-note' }, t('costNote')),
        unpriced.length > 0
          ? h(
              'div',
              { className: 'dshtu-note dshtu-warn' },
              `${t('unpriced')}：${unpriced.map((row) => row.model).join('、')}`,
            )
          : null,
      )
    }

    /**
     * 单价编辑表：每个已出现过的模型四个输入框，改完统一保存。
     *
     * 输入框用字符串状态（'' 表示不计该项），所以组件内部维护 draft，保存成功后才回填。
     * @param models - /stats 里的按模型统计。
     * @param prices - Host 当前保存的单价表。
     * @param onSave - 保存回调，收到清洗后的单价表。
     * @param busy - 保存中，禁用按钮。
     * @param savedAt - 上次保存时间，用于给出反馈。
     */
    function PriceEditor({ models, prices, onSave, busy, savedAt }) {
      /** 把 Host 的单价表转成输入框用的字符串草稿。 */
      const toDraft = (source) => {
        const out = {}
        for (const row of models) {
          const price = (source ?? {})[row.key] ?? {}
          const entry = {}
          for (const { field } of PRICE_FIELDS) {
            const value = price[field]
            entry[field] = typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
          }
          out[row.key] = entry
        }
        return out
      }

      const [draft, setDraft] = React.useState(() => toDraft(prices))
      // 记录草稿对应的价格版本；Host 回传新价格时（保存成功/刷新）才重置草稿，
      // 否则用户正在输入的内容会被一次轮询覆盖掉。
      const [base, setBase] = React.useState(() => JSON.stringify(prices ?? {}))
      const [flash, setFlash] = React.useState(false)
      const current = JSON.stringify(prices ?? {})
      if (base !== current) {
        setBase(current)
        setDraft(toDraft(prices))
      }

      const setField = (key, field, value) => {
        setDraft((previous) => ({ ...previous, [key]: { ...previous[key], [field]: value } }))
      }

      const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(prices))

      const save = () => {
        const payload = {}
        for (const [key, entry] of Object.entries(draft)) {
          const price = {}
          for (const { field } of PRICE_FIELDS) {
            const raw = String(entry[field] ?? '').trim()
            if (raw === '') continue
            const parsed = Number(raw)
            if (!Number.isFinite(parsed) || parsed < 0) continue
            price[field] = parsed
          }
          // 四项全空等于删除该模型的单价。
          if (Object.keys(price).length > 0) payload[key] = price
        }
        onSave(payload)
        setFlash(true)
      }

      React.useEffect(() => {
        if (!flash) return undefined
        const timer = setTimeout(() => setFlash(false), 2200)
        return () => clearTimeout(timer)
      }, [flash])

      const clearAll = () => {
        if (typeof window.confirm === 'function' && !window.confirm(t('confirmResetPrices'))) return
        setDraft((previous) => {
          const out = {}
          for (const key of Object.keys(previous)) {
            const entry = {}
            for (const { field } of PRICE_FIELDS) entry[field] = ''
            out[key] = entry
          }
          return out
        })
      }

      if (models.length === 0) {
        return h(
          'div',
          { className: 'dshtu-card' },
          h('div', { className: 'dshtu-section-head' }, h('h4', { className: 'dshtu-section-title' }, t('priceTitle'))),
          h('div', { className: 'dshtu-empty' }, t('priceEmpty')),
        )
      }

      const head = h(
        'div',
        { className: 'dshtu-section-head' },
        h('h4', { className: 'dshtu-section-title' }, t('priceTitle')),
        h('span', { className: 'dshtu-spacer' }),
        dirty ? h('span', { className: 'dshtu-count dshtu-warn' }, t('priceDirty')) : null,
        !dirty && flash ? h('span', { className: 'dshtu-count dshtu-ok' }, t('saved')) : null,
        !dirty && !flash && savedAt > 0 ? h('span', { className: 'dshtu-count' }, `${t('priceSavedAt')} ${formatTime(savedAt)}`) : null,
      )

      return h(
        'div',
        { className: 'dshtu-card' },
        head,
        h('div', { className: 'dshtu-note' }, t('priceHint')),
        h(
          'div',
          { className: 'dshtu-table-wrap' },
          h(
            'table',
            { className: 'dshtu-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { key: 'model' }, t('model')),
                ...PRICE_FIELDS.map(({ field, label }) => h('th', { key: field }, t(label))),
              ),
            ),
            h(
              'tbody',
              null,
              models.map((row) =>
                h(
                  'tr',
                  { key: row.key },
                  h(
                    'td',
                    { key: 'model' },
                    h(
                      'div',
                      { className: 'dshtu-model' },
                      h('span', { className: 'dshtu-model-name', title: row.model }, row.model),
                      h(
                        'div',
                        { className: 'dshtu-model-meta' },
                        row.provider ? h('span', { className: 'dshtu-badge' }, row.provider) : null,
                        costOf(row).known
                          ? h('span', { className: 'dshtu-badge' }, `¥${formatMoney(costOf(row).total)}`)
                          : h('span', { className: 'dshtu-badge' }, t('unpriced')),
                      ),
                    ),
                  ),
                  ...PRICE_FIELDS.map(({ field }) =>
                    h(
                      'td',
                      { key: field },
                      h(
                        'span',
                        { className: 'dshtu-price-cell' },
                        h('input', {
                          className: 'dshtu-price-input',
                          type: 'number',
                          min: '0',
                          step: '0.01',
                          inputMode: 'decimal',
                          placeholder: '—',
                          'aria-label': `${row.model} ${t(field === 'input' ? 'priceInput' : field === 'output' ? 'priceOutput' : field === 'cacheRead' ? 'priceCacheRead' : 'priceCacheWrite')}`,
                          value: draft[row.key]?.[field] ?? '',
                          onChange: (event) => setField(row.key, field, event.target.value),
                        }),
                        h('span', { className: 'dshtu-price-unit' }, t('priceUnit')),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshtu-actions' },
          h(
            'button',
            { className: 'dshtu-btn is-primary', type: 'button', disabled: busy || !dirty, onClick: save },
            busy ? t('saving') : t('save'),
          ),
          h('button', { className: 'dshtu-btn', type: 'button', disabled: busy || !dirty, onClick: clearAll }, t('resetPrices')),
        ),
      )
    }

    function ModelTable({ models }) {
      const maxTotal = models.reduce((max, row) => (row.totalTokens > max ? row.totalTokens : max), 0)
      const has = (key) => models.some((row) => (row[key] ?? 0) > 0)
      const anyPriced = models.some((row) => costOf(row).known)
      const columns = [
        { key: 'model', label: t('model'), when: true },
        { key: 'calls', label: t('calls'), when: true },
        { key: 'inputTokens', label: t('input'), when: true },
        { key: 'outputTokens', label: t('output'), when: true },
        { key: 'cacheReadTokens', label: t('cacheRead'), when: has('cacheReadTokens') },
        { key: 'cacheWriteTokens', label: t('cacheWrite'), when: has('cacheWriteTokens') },
        { key: 'reasoningTokens', label: t('reasoning'), when: has('reasoningTokens') },
        { key: 'totalTokens', label: t('total'), when: true },
        { key: 'cost', label: t('cost'), when: anyPriced },
      ].filter((column) => column.when)
      return h(
        'table',
        { className: 'dshtu-table' },
        h('thead', null, h('tr', null, columns.map((column) => h('th', { key: column.key }, column.label)))),
        h(
          'tbody',
          null,
          models.map((row, index) =>
            h(
              'tr',
              { key: row.key ?? index },
              columns.map((column) => {
                if (column.key === 'model') {
                  const share = maxTotal > 0 ? Math.max(2, (row.totalTokens / maxTotal) * 100) : 0
                  return h(
                    'td',
                    { key: column.key },
                    h(
                      'div',
                      { className: 'dshtu-model' },
                      h('span', { className: 'dshtu-model-name', title: row.model }, row.model),
                      h(
                        'div',
                        { className: 'dshtu-model-meta' },
                        row.provider ? h('span', { className: 'dshtu-badge' }, row.provider) : null,
                        h('span', { className: 'dshtu-share', title: `${t('share')} ${share.toFixed(1)}%` }, h('i', { style: { width: `${share}%` } })),
                      ),
                    ),
                  )
                }
                if (column.key === 'cost') {
                  const cost = costOf(row)
                  if (!cost.known) return h('td', { key: column.key }, h('span', { className: 'dshtu-empty' }, t('unpriced')))
                  return h(
                    'td',
                    { key: column.key, className: 'dshtu-money' },
                    `¥${formatMoney(cost.total)}`,
                    cost.partial ? h('span', { className: 'dshtu-price-unit dshtu-warn' }, '*') : null,
                  )
                }
                return h('td', { key: column.key }, formatNumber(row[column.key]))
              }),
            ),
          ),
        ),
      )
    }

    function DayTable({ days }) {
      const has = (key) => days.some((row) => (row[key] ?? 0) > 0)
      const columns = [
        { key: 'day', label: t('day'), when: true },
        { key: 'calls', label: t('calls'), when: true },
        { key: 'inputTokens', label: t('input'), when: true },
        { key: 'outputTokens', label: t('output'), when: true },
        { key: 'cacheReadTokens', label: t('cacheRead'), when: has('cacheReadTokens') },
        { key: 'totalTokens', label: t('total'), when: true },
      ].filter((column) => column.when)
      return h(
        'table',
        { className: 'dshtu-table' },
        h('thead', null, h('tr', null, columns.map((column) => h('th', { key: column.key }, column.label)))),
        h(
          'tbody',
          null,
          days.map((row) =>
            h(
              'tr',
              { key: row.day },
              columns.map((column) => h('td', { key: column.key }, column.key === 'day' ? row.day : formatNumber(row[column.key]))),
            ),
          ),
        ),
      )
    }

    function UsageSection() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [range, setRange] = React.useState(14)
      const [expanded, setExpanded] = React.useState(false)
      // 清零后的短暂反馈：Host 只改数字，页面不给点动静会让人以为「点了没反应」。
      const [flash, setFlash] = React.useState(null)

      React.useEffect(() => {
        if (flash === null) return undefined
        const timer = setTimeout(() => setFlash(null), 2600)
        return () => clearTimeout(timer)
      }, [flash])

      const accept = (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      }

      const load = React.useCallback(() => {
        setBusy(true)
        fetch(STATS_PATH, { headers: { accept: 'application/json' } })
          .then(accept)
          .then((payload) => {
            setData(payload)
            setError(null)
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const reset = () => {
        if (typeof window.confirm === 'function' && !window.confirm(t('confirmReset'))) return
        setBusy(true)
        fetch(RESET_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          .then(accept)
          .then((payload) => {
            setData(payload)
            setError(null)
            // 明确回一句「已清零」，否则页面只是数字变 0，很像点了没反应。
            setFlash('reset')
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }

      /** 保存单价：POST 覆盖整张表，Host 回传带新费用的完整统计。 */
      const savePrices = React.useCallback((prices) => {
        setBusy(true)
        fetch(PRICES_PATH, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ prices }),
        })
          .then(accept)
          .then((payload) => {
            setData(payload)
            setError(null)
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }, [])

      const totals = data?.totals ?? null
      const models = Array.isArray(data?.models) ? data.models : []
      const days = Array.isArray(data?.days) ? data.days : []
      const calls = totals?.calls ?? 0
      const cacheRead = totals?.cacheReadTokens ?? 0
      const stackSum = SEGMENTS.reduce((sum, segment) => sum + (totals?.[segment.key] ?? 0), 0)
      const hitRatio = cacheRead + (totals?.inputTokens ?? 0) > 0 ? cacheRead / (cacheRead + (totals?.inputTokens ?? 0)) : 0
      const animatedTotal = useCountUp(totals?.totalTokens)
      const mounted = useMounted()
      const series = React.useMemo(() => buildSeries(days, range), [data, range])
      const dayRows = expanded ? days : days.slice(0, 7)

      const head = h(
        'div',
        { className: 'dshtu-head', key: 'head' },
        h('h3', { className: 'dshtu-title' }, t('title')),
        h('span', { className: 'dshtu-live' }, h('i', { className: 'dshtu-dot' }), t('live')),
        h('span', { className: 'dshtu-spacer' }),
        flash === 'reset' ? h('span', { className: 'dshtu-count dshtu-ok' }, t('resetDone')) : null,
        h('button', { className: 'dshtu-btn', type: 'button', disabled: busy, onClick: load }, t('refresh')),
        h('button', { className: 'dshtu-btn', type: 'button', disabled: busy, onClick: reset }, t('reset')),
      )

      if (data === null) {
        return h(
          'div',
          { className: 'dshtu-root' },
          h('style', { key: 'style' }, CSS),
          head,
          error === null ? h('div', { className: 'dshtu-empty', key: 'loading' }, t('loading')) : h('div', { className: 'dshtu-error', key: 'error' }, `${t('failed')}${error}`),
        )
      }

      // 旧代码横幅：跑的是启动时缓存的旧模块时，一切「新功能不生效」都能对上号。
      const staleBanner =
        typeof data.staleSince === 'number'
          ? h(
              'div',
              { className: 'dshtu-banner', key: 'stale' },
              h('b', null, t('staleTitle')),
              h('span', null, t('staleHint')),
            )
          : null

      const hero = h(
        'div',
        { className: 'dshtu-card dshtu-hero', key: 'hero' },
        h(
          'div',
          { className: 'dshtu-hero-main' },
          h('div', { className: 'dshtu-eyebrow' }, t('total')),
          h('div', { className: 'dshtu-total' }, formatNumber(animatedTotal)),
          h(
            'div',
            { className: 'dshtu-sub' },
            h('span', null, `${t('calls')} `, h('b', null, formatNumber(calls))),
            h('span', null, `${t('perCall')} `, h('b', null, formatNumber(calls > 0 ? (totals?.totalTokens ?? 0) / calls : 0))),
            h('span', null, `${t('since')} `, formatTime(data.since)),
            h('span', null, `${t('updated')} `, formatTime(data.updatedAt)),
          ),
        ),
        h(CacheRing, { ratio: hitRatio, mounted }),
      )

      const legend = SEGMENTS.map((segment) =>
        h(
          'span',
          { className: 'dshtu-legend-item', key: segment.key },
          h('i', { className: `dshtu-swatch dshtu-tone-${segment.tone}` }),
          t(segment.label),
          h('b', null, formatNumber(totals?.[segment.key])),
          ` · ${stackSum > 0 ? (((totals?.[segment.key] ?? 0) / stackSum) * 100).toFixed(1) : '0.0'}%`,
        ),
      )
      if ((totals?.reasoningTokens ?? 0) > 0) {
        legend.push(
          h(
            'span',
            { className: 'dshtu-legend-item', key: 'reasoning' },
            h('i', { className: 'dshtu-swatch dshtu-tone-muted' }),
            t('reasoning'),
            h('b', null, formatNumber(totals?.reasoningTokens)),
          ),
        )
      }

      const breakdown = h(
        'div',
        { className: 'dshtu-card', key: 'breakdown' },
        h('div', { className: 'dshtu-section-head' }, h('h4', { className: 'dshtu-section-title' }, t('breakdown'))),
        h(
          'div',
          { className: 'dshtu-stack' },
          SEGMENTS.filter((segment) => (totals?.[segment.key] ?? 0) > 0).map((segment, index) =>
            h('i', {
              key: segment.key,
              className: `dshtu-fill dshtu-tone-${segment.tone}`,
              style: {
                width: `${stackSum > 0 ? ((totals?.[segment.key] ?? 0) / stackSum) * 100 : 0}%`,
                animationDelay: `${index * 60}ms`,
              },
            }),
          ),
        ),
        h('div', { className: 'dshtu-legend' }, legend),
      )

      const trend = h(
        'div',
        { className: 'dshtu-card', key: 'trend' },
        h(
          'div',
          { className: 'dshtu-section-head' },
          h('h4', { className: 'dshtu-section-title' }, t('trend')),
          h('span', { className: 'dshtu-spacer' }),
          h(
            'span',
            { className: 'dshtu-seg' },
            [7, 14, 30].map((option) =>
              h(
                'button',
                {
                  key: option,
                  type: 'button',
                  className: `dshtu-btn${option === range ? ' is-on' : ''}`,
                  onClick: () => setRange(option),
                },
                `${option}${t('dayUnit')}`,
              ),
            ),
          ),
        ),
        h(TrendChart, { series, range }),
      )

      const modelCard = h(
        'div',
        { className: 'dshtu-card', key: 'models' },
        h(
          'div',
          { className: 'dshtu-section-head' },
          h('h4', { className: 'dshtu-section-title' }, t('byModel')),
          h('span', { className: 'dshtu-count' }, `${models.length}`),
        ),
        models.length === 0 ? h('div', { className: 'dshtu-empty' }, t('empty')) : h('div', { className: 'dshtu-table-wrap' }, h(ModelTable, { models })),
      )

      const costCard = models.length === 0 ? null : h(CostCard, { key: 'cost', data, models })

      const priceCard = h(PriceEditor, {
        key: 'prices',
        models,
        prices: data.prices ?? {},
        onSave: savePrices,
        busy,
        savedAt: data.pricesUpdatedAt ?? 0,
      })

      const dayCard = h(
        'div',
        { className: 'dshtu-card', key: 'days' },
        h(
          'div',
          { className: 'dshtu-section-head' },
          h('h4', { className: 'dshtu-section-title' }, t('byDay')),
          h('span', { className: 'dshtu-count' }, `${days.length}`),
          h('span', { className: 'dshtu-spacer' }),
          days.length > 7
            ? h('button', { className: 'dshtu-btn', type: 'button', onClick: () => setExpanded((value) => !value) }, expanded ? t('collapse') : t('expand'))
            : null,
        ),
        days.length === 0 ? h('div', { className: 'dshtu-empty' }, t('empty')) : h('div', { className: 'dshtu-table-wrap' }, h(DayTable, { days: dayRows })),
      )

      // 数据兜底提示：只在真的触发过时出现，平时不占地方。
      // 三件事都可能让用户以为「数据丢了」，这里明确告诉他数据在哪、能不能救回。
      const recoverNotices = [
        data.corruptBackup ? h('div', { className: 'dshtu-note dshtu-warn', key: 'corrupt' }, `${t('corruptBackup')} ${data.corruptBackup}`) : null,
        data.restoredFrom ? h('div', { className: 'dshtu-note dshtu-ok', key: 'restored' }, `${t('restoredFrom')} ${data.restoredFrom}`) : null,
        data.resetBackup ? h('div', { className: 'dshtu-note', key: 'resetsnap' }, `${t('resetBackup')} ${data.resetBackup}`) : null,
      ].filter(Boolean)

      const foot = h('div', { className: 'dshtu-foot', key: 'foot' }, `${t('file')}：${data.file ?? '—'}`)

      return h(
        'div',
        { className: 'dshtu-root' },
        h('style', { key: 'style' }, CSS),
        head,
        staleBanner,
        error === null ? null : h('div', { className: 'dshtu-error', key: 'error' }, `${t('failed')}${error}`),
        hero,
        costCard,
        breakdown,
        trend,
        modelCard,
        priceCard,
        dayCard,
        ...recoverNotices,
        foot,
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
