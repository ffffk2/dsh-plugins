/**
 * Token 统计 —— Client 半。
 *
 * 设置面板里的一个 `settings.section` 页面，做成仪表盘：
 *   ① 主视觉：总 Token（渐变数字 + 滚动动画）+ 缓存命中率圆环
 *   ② 构成条：输入 / 输出 / 缓存命中（+ 缓存写入、推理，有值才出现）堆叠占比
 *   ③ 趋势图：近 7 / 14 / 30 天柱状图，逐根生长动画，悬停看具体数值
 *   ④ 按模型表：列自适应（全为 0 的列不出现）+ 每行占比条
 *   ⑤ 按天表：默认 7 行，可展开到全部
 *
 * 数据来自同包 Host 半的 GET /token-usage/stats；清零走 POST /token-usage/reset。
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
    const RINGS = { size: 88, radius: 34, width: 8 }

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
      confirmReset: '确定清零累计统计吗？此操作不可撤销。',
      loading: '加载中…',
      empty: '暂无记录。发出任意一次模型对话后回到这里即可看到累计。',
      file: '数据文件',
      since: '统计起始',
      updated: '最近更新',
      failed: '读取失败：',
      expand: '展开全部',
      collapse: '收起',
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
      confirmReset: 'Reset all accumulated token usage? This cannot be undone.',
      loading: 'Loading…',
      empty: 'No records yet. Send one model message and come back.',
      file: 'Data file',
      since: 'Counting since',
      updated: 'Last updated',
      failed: 'Load failed: ',
      expand: 'Show all',
      collapse: 'Collapse',
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

    function ModelTable({ models }) {
      const maxTotal = models.reduce((max, row) => (row.totalTokens > max ? row.totalTokens : max), 0)
      const has = (key) => models.some((row) => (row[key] ?? 0) > 0)
      const columns = [
        { key: 'model', label: t('model'), when: true },
        { key: 'calls', label: t('calls'), when: true },
        { key: 'inputTokens', label: t('input'), when: true },
        { key: 'outputTokens', label: t('output'), when: true },
        { key: 'cacheReadTokens', label: t('cacheRead'), when: has('cacheReadTokens') },
        { key: 'cacheWriteTokens', label: t('cacheWrite'), when: has('cacheWriteTokens') },
        { key: 'reasoningTokens', label: t('reasoning'), when: has('reasoningTokens') },
        { key: 'totalTokens', label: t('total'), when: true },
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
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }

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

      const foot = h('div', { className: 'dshtu-foot', key: 'foot' }, `${t('file')}：${data.file ?? '—'}`)

      return h(
        'div',
        { className: 'dshtu-root' },
        h('style', { key: 'style' }, CSS),
        head,
        error === null ? null : h('div', { className: 'dshtu-error', key: 'error' }, `${t('failed')}${error}`),
        hero,
        breakdown,
        trend,
        modelCard,
        dayCard,
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
