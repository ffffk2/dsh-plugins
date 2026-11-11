/**
 * 系统资源监视 —— Client 半。
 *
 * 左下角常驻一枚小 HUD：CPU / 内存各一条细进度条；鼠标悬停（或键盘聚焦）
 * 在它上方展开一张卡片，列出 CPU 与内存各自占用最高的 5 个进程。
 *
 * 位置：注册到 `shell.overlay`（框架级浮层，位于所有列之上、且在滚动容器之外），
 * 自己是 fixed 定位的绝对子元素，`left/bottom` 固定在左下角。没有塞进侧栏底部，
 * 因为侧栏有 `overflow:hidden`，悬停卡片会被裁掉；浮层是官方为 badge/状态条
 * 准备的加性槽位，不会遮住侧栏的「设置」按钮（底部让出 54px）。
 *
 * 数据：系统指标每 10 秒轮询一次；进程榜只在悬停时请求，Host 端缓存 10 秒，
 * 面板打开期间同样每 10 秒刷新。没有数据时保留上一次读数，只在标题旁点一个红点。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sysmon',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'sysmon'
    const METRICS_PATH = '/sysmon/metrics'
    const PROCESSES_PATH = '/sysmon/processes'
    /** 与 Host 的采样节奏一致：每 10 秒取一次。 */
    const REFRESH_MS = 10_000
    /** 采样器还在冷启动时，隔 2 秒再试，不让用户等满 10 秒。 */
    const WARM_RETRY_MS = 2_000
    /** 面板里每一列最多显示多少个进程。 */
    const MAX_ROWS = 5

    const zh = {
      title: '系统资源',
      cpu: 'CPU',
      mem: '内存',
      topCpu: 'CPU 占用最高',
      topMem: '内存占用最高',
      cores: '核',
      processCount: '个进程',
      updated: '更新于',
      refreshes: '每 10 秒刷新',
      sampling: '正在采样进程…',
      noData: '暂无数据',
      metricsFailed: '读取不到资源占用',
      processFailed: '读取不到进程列表，稍后自动重试',
      cpuLifetime: 'CPU 为进程生命周期均值',
      pillHint: '悬停查看占用最高的进程',
    }

    const en = {
      title: 'System resources',
      cpu: 'CPU',
      mem: 'MEM',
      topCpu: 'Top CPU',
      topMem: 'Top memory',
      cores: 'cores',
      processCount: 'processes',
      updated: 'Updated',
      refreshes: 'Refreshes every 10 s',
      sampling: 'Sampling processes…',
      noData: 'No data',
      metricsFailed: 'Resource data is unavailable',
      processFailed: 'Process list is unavailable; retrying automatically',
      cpuLifetime: 'CPU is the process lifetime average',
      pillHint: 'Hover for the top processes',
    }

    const CSS = `
.dshts-hud { position:absolute; left:12px; bottom:54px; z-index:1; display:flex; flex-direction:column; align-items:flex-start; gap:8px; color:var(--dsw-alias-label-primary); font-family:var(--ds-font-family); font-size:11px; line-height:1.4; pointer-events:auto; }
.dshts-hud *, .dshts-hud *::before, .dshts-hud *::after { box-sizing:border-box; }

.dshts-pill { display:flex; align-items:stretch; gap:11px; min-width:136px; padding:6px 10px 7px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); outline:none; cursor:default; user-select:none; transition:border-color .15s ease; }
.dshts-pill:hover { border-color:var(--dsw-alias-border-l2); }
.dshts-pill:focus-visible { border-color:var(--dsw-alias-brand-primary); }

.dshts-gauge { display:flex; flex-direction:column; gap:4px; flex:1 1 0; min-width:54px; }
.dshts-gauge-head { display:flex; align-items:baseline; justify-content:space-between; gap:6px; }
.dshts-gauge-label { font-size:9px; font-weight:600; letter-spacing:.07em; color:var(--dsw-alias-label-secondary); }
.dshts-gauge-value { font-family:var(--ds-font-family-code); font-size:11px; font-weight:600; color:var(--dsw-alias-label-primary); font-variant-numeric:tabular-nums; }
.dshts-track { height:2px; border-radius:1px; background:var(--dsw-alias-border-l1); overflow:hidden; }
.dshts-fill { display:block; height:100%; border-radius:1px; background:var(--dsw-alias-brand-primary); transition:width .35s ease; }
.dshts-fill.is-mem { background:var(--dsw-alias-state-business-primary); }
.dshts-fill.is-warn { background:var(--dsw-alias-state-warn-primary); }
.dshts-fill.is-hot { background:var(--dsw-alias-state-error-primary); }
.dshts-fill.is-idle { background:var(--dsw-alias-label-secondary); opacity:.35; }

.dshts-panel { width:436px; max-width:calc(100vw - 24px); padding:11px 12px 9px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-layer-2); animation:dshts-rise .14s ease-out; }
@keyframes dshts-rise { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:none; } }
@media (prefers-reduced-motion:reduce) { .dshts-panel { animation:none; } .dshts-fill { transition:none; } }

.dshts-panel-head { display:flex; align-items:center; gap:8px; }
.dshts-title { font-size:12px; font-weight:600; }
.dshts-meta { margin-left:auto; display:inline-flex; align-items:center; gap:5px; font-family:var(--ds-font-family-code); font-size:10px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dshts-dot { width:5px; height:5px; border-radius:50%; background:var(--dsw-alias-state-success-primary); }
.dshts-dot.is-error { background:var(--dsw-alias-state-error-primary); }

.dshts-cols { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:10px; }
.dshts-col { min-width:0; }
.dshts-col-head { display:flex; align-items:baseline; justify-content:space-between; gap:6px; padding-bottom:4px; border-bottom:.5px solid var(--dsw-alias-border-l1); }
.dshts-col-title { font-size:10px; font-weight:600; color:var(--dsw-alias-label-secondary); }
.dshts-proc { display:flex; align-items:baseline; gap:8px; padding:3px 0; }
.dshts-proc-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:var(--dsw-alias-label-primary); }
.dshts-proc-value { flex:none; font-family:var(--ds-font-family-code); font-size:10px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dshts-empty { padding:7px 0; font-size:10px; color:var(--dsw-alias-label-secondary); }

.dshts-note { margin-top:8px; font-size:10px; line-height:1.5; color:var(--dsw-alias-label-secondary); }
.dshts-note.is-error { color:var(--dsw-alias-state-error-primary); }
.dshts-foot { display:flex; flex-wrap:wrap; gap:2px 10px; margin-top:9px; padding-top:7px; border-top:.5px solid var(--dsw-alias-border-l1); font-size:9px; color:var(--dsw-alias-label-secondary); }
`

    /** 翻译函数由 apply 绑定；组件渲染时读取。 */
    let t = (key) => key

    /** 百分比取整；空值显示破折号。 */
    function formatPercent(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return `${Math.round(number)}%`
    }

    /** 进程 CPU 保留一位小数，低于 10% 时才看得出差别。 */
    function formatOneDecimal(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return `${Math.round(number * 10) / 10}%`
    }

    /** 字节 → GB / MB；进程工作集常见几百 MB，用 GB 会全变成 0.4 GB。 */
    function formatBytes(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return '0'
      const gb = number / 1024 ** 3
      if (gb >= 1) return `${gb.toFixed(1)} GB`
      return `${Math.max(1, Math.round(number / 1024 ** 2))} MB`
    }

    /** 本地时区的 HH:MM:SS。 */
    function formatClock(value) {
      const date = new Date(Number(value))
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (part) => String(part).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** 60% 转黄、85% 转红；其余用各自的基础色。 */
    function toneOf(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return 'idle'
      if (number >= 85) return 'hot'
      if (number >= 60) return 'warn'
      return 'calm'
    }

    function acceptJson(response) {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /**
     * 一条指标：标题、读数、细进度条。
     * @param label - 显示的短标签。
     * @param percent - 占用百分比；非数字显示破折号。
     * @param mem - 是否内存（换基础色）。
     */
    function Gauge(label, percent, mem) {
      const number = Number(percent)
      const width = Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0
      const tone = toneOf(percent)
      return h(
        'div',
        { className: 'dshts-gauge', key: label },
        h(
          'div',
          { className: 'dshts-gauge-head' },
          h('span', { className: 'dshts-gauge-label' }, label),
          h('span', { className: 'dshts-gauge-value' }, formatPercent(percent)),
        ),
        h(
          'div',
          { className: 'dshts-track' },
          h('i', { className: `dshts-fill${mem ? ' is-mem' : ''} is-${tone}`, style: { width: `${width}%` } }),
        ),
      )
    }

    /**
     * 排行榜的一列。
     * @param title - 列标题。
     * @param rows - 进程数组。
     * @param kind - `cpu` / `mem`，决定数值格式。
     */
    function ProcessColumn(title, rows, kind) {
      return h(
        'div',
        { className: 'dshts-col', key: kind },
        h('div', { className: 'dshts-col-head' }, h('span', { className: 'dshts-col-title' }, title)),
        rows.length === 0
          ? h('div', { className: 'dshts-empty' }, t('noData'))
          : rows.map((row, index) =>
              h(
                'div',
                { className: 'dshts-proc', key: `${kind}-${row.pid}-${index}` },
                h('span', { className: 'dshts-proc-name', title: `${row.name} · PID ${row.pid}` }, row.name),
                h('span', { className: 'dshts-proc-value' }, kind === 'cpu' ? formatOneDecimal(row.cpu) : formatBytes(row.mem)),
              ),
            ),
      )
    }

    /**
     * 悬停卡片。
     * @param props - 指标、进程榜与错误状态。
     */
    function renderPanel(props) {
      const { metrics, processes, metricsError, sampling, processError } = props
      const available = processes !== null && processes.available === true
      const cpuRows = Array.isArray(processes?.cpu) ? processes.cpu.slice(0, MAX_ROWS) : []
      const memRows = Array.isArray(processes?.mem) ? processes.mem.slice(0, MAX_ROWS) : []
      const note = processError !== null
        ? h('div', { className: 'dshts-note is-error', title: String(processError) }, t('processFailed'))
        : !available && sampling
          ? h('div', { className: 'dshts-note' }, t('sampling'))
          : available && processes.cpuMode === 'lifetime'
            ? h('div', { className: 'dshts-note' }, t('cpuLifetime'))
            : null
      return h(
        'div',
        { className: 'dshts-panel', key: 'panel', role: 'group', 'aria-label': t('title') },
        h(
          'div',
          { className: 'dshts-panel-head' },
          h('span', { className: 'dshts-title' }, t('title')),
          h(
            'span',
            { className: 'dshts-meta' },
            h('i', { className: `dshts-dot${metricsError !== null ? ' is-error' : ''}` }),
            h('span', null, metrics !== null ? formatClock(metrics.ts) : '—'),
          ),
        ),
        h('div', { className: 'dshts-cols' }, ProcessColumn(t('topCpu'), cpuRows, 'cpu'), ProcessColumn(t('topMem'), memRows, 'mem')),
        note,
        h(
          'div',
          { className: 'dshts-foot' },
          metrics !== null
            ? [
                h('span', { key: 'mem' }, `${t('mem')} ${formatBytes(metrics.mem.used)} / ${formatBytes(metrics.mem.total)}`),
                h('span', { key: 'cores' }, `${metrics.cpu.cores} ${t('cores')}`),
              ]
            : h('span', { key: 'failed' }, t('metricsFailed')),
          available ? h('span', { key: 'count' }, `${processes.processCount} ${t('processCount')}`) : null,
          h('span', { key: 'cadence' }, t('refreshes')),
        ),
      )
    }

    function SysmonHud() {
      const [metrics, setMetrics] = React.useState(null)
      const [metricsError, setMetricsError] = React.useState(null)
      const [processes, setProcesses] = React.useState(null)
      const [processError, setProcessError] = React.useState(null)
      const [sampling, setSampling] = React.useState(false)
      const [open, setOpen] = React.useState(false)

      // 指标常驻轮询：无论卡片开没开，左下角都要是「实时」的。
      React.useEffect(() => {
        let stopped = false
        const load = () => {
          fetch(METRICS_PATH, { headers: { accept: 'application/json' } })
            .then(acceptJson)
            .then((payload) => {
              if (stopped) return
              setMetrics(payload)
              setMetricsError(null)
            })
            .catch((cause) => {
              if (stopped) return
              setMetricsError(cause instanceof Error ? cause.message : String(cause))
            })
        }
        load()
        const timer = setInterval(load, REFRESH_MS)
        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') load()
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility)
        }
        return () => {
          stopped = true
          clearInterval(timer)
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }
      }, [])

      // 进程榜只在卡片打开时拉；Host 端会把 9 秒内的请求合成一次采样。
      React.useEffect(() => {
        if (!open) return undefined
        let stopped = false
        let retry = null
        const load = () => {
          setSampling(true)
          fetch(PROCESSES_PATH, { headers: { accept: 'application/json' } })
            .then(acceptJson)
            .then((payload) => {
              if (stopped) return
              setSampling(false)
              if (payload !== null && typeof payload === 'object' && payload.available === true) {
                setProcesses(payload)
                setProcessError(null)
                return
              }
              // 冷启动中的采样器：保留上一份数据，2 秒后再问一次。
              setProcessError(typeof payload?.reason === 'string' ? payload.reason : 'unavailable')
              retry = setTimeout(load, WARM_RETRY_MS)
            })
            .catch((cause) => {
              if (stopped) return
              setSampling(false)
              setProcessError(cause instanceof Error ? cause.message : String(cause))
            })
        }
        load()
        const timer = setInterval(load, REFRESH_MS)
        return () => {
          stopped = true
          clearInterval(timer)
          if (retry !== null) clearTimeout(retry)
        }
      }, [open])

      const cpuPercent = metrics?.cpu?.percent
      const memPercent = metrics?.mem?.percent
      const label =
        metrics === null
          ? `${t('title')} · ${t('pillHint')}`
          : `${t('title')}: ${t('cpu')} ${formatPercent(cpuPercent)}, ${t('mem')} ${formatPercent(memPercent)} · ${t('pillHint')}`
      return h(
        'div',
        {
          className: 'dshts-hud',
          onMouseEnter: () => setOpen(true),
          onMouseLeave: () => setOpen(false),
        },
        h('style', { key: 'style' }, CSS),
        open ? renderPanel({ metrics, processes, metricsError, sampling, processError }) : null,
        h(
          'div',
          {
            className: 'dshts-pill',
            tabIndex: 0,
            role: 'group',
            'aria-label': label,
            'aria-expanded': open ? 'true' : 'false',
            onFocus: () => setOpen(true),
            onBlur: () => setOpen(false),
            onKeyDown: (event) => {
              if (event.key === 'Escape') setOpen(false)
            },
          },
          Gauge(t('cpu'), cpuPercent, false),
          Gauge(t('mem'), memPercent, true),
        ),
      )
    }

    function apply(ctx) {
      t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sysmon: dictionaries')
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'sysmon',
            order: 20,
            label: () => t('title'),
            locale: NS,
          },
          SysmonHud,
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
