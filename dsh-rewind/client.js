/**
 * 对话回滚（Rewind）—— Client 半。
 *
 * 在输入框上方（`conversation.input.dock`，full-width 的 list 槽位）挂一条回滚面板：
 *   · 收起态：一个「回滚对话」按钮，外加当前回滚点的状态条（可撤销文件回滚）
 *   · 展开态：列出这个会话里我发过的每条消息（带时间与摘要），点任意一条即可回到那一刻
 *
 * 数据全部来自同包 Host 半的三条同源路由：
 *   GET  /rewind/points      列出可回滚的消息与快照状态
 *   POST /rewind/apply       执行回滚
 *   POST /rewind/undo-files  撤销上一次的文件回滚
 *
 * 只用宿主主题 token（--dsw-alias-*）着色，不引入任何 Harness Client 包。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-rewind',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'rewind'
    const POINTS_PATH = '/rewind/points'
    const APPLY_PATH = '/rewind/apply'
    const UNDO_FILES_PATH = '/rewind/undo-files'
    /** 面板里最多同时渲染多少条候选消息，避免超长会话把 DOM 撑爆。 */
    const MAX_ROWS = 200
    /** 静默刷新间隔：新消息与另一窗口的回滚都靠它自己冒出来。 */
    const REFRESH_MS = 20_000

    const zh = {
      open: '回滚对话',
      close: '收起',
      refresh: '刷新',
      title: '回到我发过的某条消息',
      subtitle: '把模型上下文与工作区文件都撤回那一刻。',
      irreversible: '上下文回滚不可撤销：被撤回的消息仍留在会话日志与轨迹里，但不会再进入模型上下文。',
      empty: '还没有可回滚的节点。每条消息发出时都会自动拍一份快照，刚发出的消息稍等片刻再刷新。',
      loading: '读取中…',
      failed: '读取失败：',
      noSession: '当前会话不可用。',
      rowBack: '回到此处',
      confirm: '确认回滚',
      cancel: '取消',
      restoreFiles: '同时还原工作区文件',
      restoreFilesOff: '（这条消息没有可用的文件快照）',
      keepMessage: '保留这条消息在上下文里',
      keepMessageHint: '不勾选 = 连同这条消息一起撤回',
      tail: '其后共 {n} 条上下文',
      snapshotReady: '{n} 个文件已快照',
      snapshotMissing: '无文件快照',
      inactive: '已不在上下文中',
      applied: '已回滚',
      hidden: '撤回 {n} 条上下文',
      filesRestored: '还原 {n} 个文件',
      filesDeleted: '删除 {n} 个新增文件',
      filesSkipped: '跳过 {n} 个文件',
      undoFiles: '撤销文件回滚',
      undoing: '撤销中…',
      undone: '已把文件恢复成回滚前的样子',
      notLive: '会话尚未激活，回到该对话后再试。',
      busy: '当前回合还在进行，请先停止后再回滚。',
      gone: '这条消息已不在当前上下文里。',
      keepNotice: '保留该消息：回滚后它仍是最后一条用户消息。',
      working: '回滚中…',
    }

    const en = {
      open: 'Roll back',
      close: 'Collapse',
      refresh: 'Refresh',
      title: 'Return to one of my messages',
      subtitle: 'Withdraw model context and workspace files back to that moment.',
      irreversible: 'Context rollback cannot be undone: the withdrawn messages stay in the session log and trajectory, but leave the model context for good.',
      empty: 'No rollback points yet. A snapshot is taken for every message you send — refresh in a moment for a brand new one.',
      loading: 'Loading…',
      failed: 'Load failed: ',
      noSession: 'This session is unavailable.',
      rowBack: 'Return here',
      confirm: 'Confirm rollback',
      cancel: 'Cancel',
      restoreFiles: 'Also restore workspace files',
      restoreFilesOff: '(no file snapshot for this message)',
      keepMessage: 'Keep this message in context',
      keepMessageHint: 'Unchecked = withdraw this message too',
      tail: '{n} later context entries',
      snapshotReady: '{n} files snapshotted',
      snapshotMissing: 'no file snapshot',
      inactive: 'no longer in context',
      applied: 'Rolled back',
      hidden: 'withdrew {n} context entries',
      filesRestored: 'restored {n} files',
      filesDeleted: 'deleted {n} created files',
      filesSkipped: 'skipped {n} files',
      undoFiles: 'Undo file rollback',
      undoing: 'Undoing…',
      undone: 'Files restored to their pre-rollback state',
      notLive: 'The session is not active yet; open the conversation and retry.',
      busy: 'A turn is still running; stop it before rolling back.',
      gone: 'That message is no longer in the current context.',
      keepNotice: 'Keeping the message: it stays as the last user message after the rollback.',
      working: 'Rolling back…',
    }

    // 由 apply 绑定的翻译函数；组件渲染时读取。
    let t = (key) => key

    /** 带 {n} 占位符的文案替换。 */
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    /** 时间戳 → 本地 HH:MM。 */
    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const date = new Date(ms)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    /** 统一取 JSON；HTTP 错误也返回解析后的 body，交给调用方判断 ok。 */
    async function request(path, init) {
      const options = { headers: { accept: 'application/json' }, ...init }
      if (options.body !== undefined) options.headers['content-type'] = 'application/json'
      const response = await fetch(path, options)
      try {
        return await response.json()
      } catch {
        return { ok: false, error: { code: 'bad-response', message: `HTTP ${response.status}` } }
      }
    }

    /** 把 Host 的错误 code 换成本地化文案。 */
    function describeError(payload) {
      const code = payload?.error?.code
      if (code === 'agent-busy') return t('busy')
      if (code === 'session-not-live') return t('notLive')
      if (code === 'not-on-surface' || code === 'not-found') return t('gone')
      return payload?.error?.message ?? t('failed')
    }

    const CSS = `
.dshrw-root { display:flex; flex-direction:column; gap:8px; color:var(--dsw-alias-label-primary); font-size:13px; width:100%; }
.dshrw-root *, .dshrw-root *::before, .dshrw-root *::after { box-sizing:border-box; }

.dshrw-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-height:28px; }
.dshrw-btn { height:26px; padding:0 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; transition:color .15s, border-color .15s, background-color .15s; }
.dshrw-btn:hover:not([disabled]) { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dshrw-btn[disabled] { opacity:.45; cursor:default; }
.dshrw-btn.is-primary { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.dshrw-btn.is-danger { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); }
.dshrw-chip { display:inline-flex; align-items:center; gap:6px; height:24px; max-width:100%; padding:0 9px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); font-size:11px; }
.dshrw-chip-text { max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshrw-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-warn-primary); flex:none; }
.dshrw-error { color:var(--dsw-alias-state-error-primary); font-size:12px; }
.dshrw-warn { color:var(--dsw-alias-state-warn-primary); font-size:12px; }
.dshrw-ok { color:var(--dsw-alias-state-success-primary); font-size:12px; }

.dshrw-panel { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); padding:10px; display:flex; flex-direction:column; gap:8px; }
.dshrw-head { display:flex; align-items:baseline; gap:8px; }
.dshrw-title { margin:0; font-size:13px; font-weight:600; }
.dshrw-sub { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dshrw-spacer { flex:1 1 auto; }
.dshrw-note { color:var(--dsw-alias-state-warn-primary); font-size:11px; line-height:1.5; }
.dshrw-empty { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.6; }

.dshrw-list { display:flex; flex-direction:column; gap:6px; max-height:268px; overflow:auto; padding-right:2px; }
.dshrw-row { border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:var(--dsw-alias-bg-layer-2); padding:7px 9px; display:flex; flex-direction:column; gap:6px; }
.dshrw-row.is-inactive { opacity:.55; }
.dshrw-row.is-open { border-color:var(--dsw-alias-brand-primary); }
.dshrw-row-top { display:flex; align-items:center; gap:8px; }
.dshrw-seq { color:var(--dsw-alias-label-secondary); font-size:11px; font-variant-numeric:tabular-nums; flex:none; }
.dshrw-preview { flex:1 1 auto; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; line-height:1.5; word-break:break-word; }
.dshrw-meta { color:var(--dsw-alias-label-secondary); font-size:11px; flex:none; display:inline-flex; gap:6px; align-items:center; }
.dshrw-inactive { color:var(--dsw-alias-state-warn-primary); font-size:11px; flex:none; }
.dshrw-confirm { display:flex; flex-direction:column; gap:6px; border-top:1px dashed var(--dsw-alias-border-l2); padding-top:7px; }
.dshrw-check { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dshrw-check input { cursor:pointer; }
.dshrw-actions { display:flex; gap:8px; align-items:center; }
`

    /**
     * 输入框上方的回滚面板：列出可回滚的消息，并驱动一次回滚。
     * @param props - 槽位注入的会话上下文（`sessionId` 由 session 作用域的槽位提供）。
     */
    function RewindDock(props) {
      const sessionId = props.sessionId ?? props.session?.id
      const [open, setOpen] = React.useState(false)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [confirmSeq, setConfirmSeq] = React.useState(null)
      const [restoreFiles, setRestoreFiles] = React.useState(true)
      const [keepMessage, setKeepMessage] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const [undoBusy, setUndoBusy] = React.useState(false)
      /** 上一次的响应原文：内容没变就不 setState，避免轮询把面板刷得发抖。 */
      const lastPayload = React.useRef('')

      /** 拉一次回滚点；失败不抛，只落在 error 上。 */
      const load = React.useCallback(
        async (silent) => {
          if (sessionId === undefined) return
          if (!silent) setLoading(true)
          try {
            const payload = await request(`${POINTS_PATH}?sessionId=${encodeURIComponent(sessionId)}`)
            if (payload?.ok === true) {
              const text = JSON.stringify(payload)
              if (text !== lastPayload.current) {
                lastPayload.current = text
                setData(payload)
              }
              setError(null)
            } else {
              setError(describeError(payload))
            }
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          } finally {
            if (!silent) setLoading(false)
          }
        },
        [sessionId],
      )

      React.useEffect(() => {
        void load(true)
      }, [load])

      React.useEffect(() => {
        if (open) void load(false)
      }, [open, load])

      // 会话里的新消息由别的模块驱动，这里只做低频静默轮询：
      // 让「刚发出的消息」和「另一个窗口里的回滚」都能自己冒出来。
      React.useEffect(() => {
        const timer = setInterval(() => void load(true), REFRESH_MS)
        return () => clearInterval(timer)
      }, [load])

      if (sessionId === undefined) return h('div', { className: 'dshrw-root' }, t('noSession'))

      /** 执行一次回滚。 */
      const apply = async (seq) => {
        setBusy(true)
        setError(null)
        try {
          const payload = await request(APPLY_PATH, {
            method: 'POST',
            body: JSON.stringify({ sessionId, seq, restoreFiles, keepMessage }),
          })
          if (payload?.ok === true) {
            setResult(payload.value)
            setConfirmSeq(null)
            await load(true)
          } else {
            setError(describeError(payload))
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      /** 只把文件恢复成回滚前的样子（上下文不动）。 */
      const undoFiles = async () => {
        setUndoBusy(true)
        setError(null)
        try {
          const payload = await request(UNDO_FILES_PATH, { method: 'POST', body: JSON.stringify({ sessionId }) })
          if (payload?.ok === true) {
            setResult(null)
            await load(true)
          } else {
            setError(describeError(payload))
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setUndoBusy(false)
        }
      }

      const points = Array.isArray(data?.points) ? data.points : []
      const lastRollback = data?.lastRollback ?? null
      const canUndoFiles = typeof lastRollback?.safety === 'string'

      const bar = h(
        'div',
        { className: 'dshrw-bar', key: 'bar' },
        h(
          'button',
          { type: 'button', className: `dshrw-btn${open ? ' is-primary' : ''}`, onClick: () => setOpen((value) => !value) },
          open ? t('close') : t('open'),
        ),
        lastRollback === null
          ? null
          : h(
              'span',
              { className: 'dshrw-chip', key: 'last', title: lastRollback.preview ?? '' },
              h('span', { className: 'dshrw-dot' }),
              h('span', { className: 'dshrw-chip-text' }, `${t('applied')}：${lastRollback.preview || `#${lastRollback.targetSeq}`}`),
              h('span', null, fill(t('hidden'), { n: lastRollback.hiddenCount ?? 0 })),
            ),
        canUndoFiles
          ? h(
              'button',
              { type: 'button', className: 'dshrw-btn', key: 'undo', disabled: undoBusy, onClick: () => void undoFiles() },
              undoBusy ? t('undoing') : t('undoFiles'),
            )
          : null,
        h('span', { className: 'dshrw-spacer' }),
        result === null
          ? null
          : h(
              'span',
              { className: 'dshrw-ok', key: 'result' },
              [
                fill(t('hidden'), { n: result.hiddenCount }),
                result.files === null
                  ? null
                  : `${fill(t('filesRestored'), { n: result.files.restored.length })}，${fill(t('filesDeleted'), { n: result.files.deleted.length })}`,
              ]
                .filter(Boolean)
                .join(' · '),
            ),
        error === null ? null : h('span', { className: 'dshrw-error' }, error),
      )

      if (!open) return h('div', { className: 'dshrw-root' }, h('style', null, CSS), bar)

      /** 一行候选消息；点「回到此处」在这行内展开确认区。 */
      const renderRow = (point) => {
        const inactive = point.active === false
        const snapshotReady = point.snapshot !== null && point.snapshot.state === 'ready'
        const confirming = confirmSeq === point.seq
        const meta = []
        if (Number.isFinite(point.tail)) meta.push(fill(t('tail'), { n: point.tail }))
        meta.push(
          snapshotReady ? fill(t('snapshotReady'), { n: point.snapshot.files }) : t('snapshotMissing'),
        )
        return h(
          'div',
          { className: `dshrw-row${inactive ? ' is-inactive' : ''}${confirming ? ' is-open' : ''}`, key: point.seq },
          h(
            'div',
            { className: 'dshrw-row-top' },
            h('span', { className: 'dshrw-seq' }, formatTime(point.time) || `#${point.seq}`),
            h('span', { className: 'dshrw-preview' }, point.preview || '(空消息)'),
            inactive ? h('span', { className: 'dshrw-inactive' }, t('inactive')) : null,
            h('span', { className: 'dshrw-meta' }, meta.join(' · ')),
            confirming
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshrw-btn',
                    disabled: inactive,
                    onClick: () => {
                      setConfirmSeq(point.seq)
                      setKeepMessage(false)
                      setRestoreFiles(snapshotReady)
                      setResult(null)
                    },
                  },
                  t('rowBack'),
                ),
          ),
          confirming
            ? h(
                'div',
                { className: 'dshrw-confirm' },
                h(
                  'label',
                  { className: 'dshrw-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: restoreFiles && snapshotReady,
                    disabled: !snapshotReady,
                    onChange: (event) => setRestoreFiles(event.target.checked),
                  }),
                  snapshotReady ? t('restoreFiles') : `${t('restoreFiles')} ${t('restoreFilesOff')}`,
                ),
                h(
                  'label',
                  { className: 'dshrw-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: keepMessage,
                    onChange: (event) => setKeepMessage(event.target.checked),
                  }),
                  `${t('keepMessage')} · ${t('keepMessageHint')}`,
                ),
                h('div', { className: 'dshrw-note' }, t('irreversible')),
                h(
                  'div',
                  { className: 'dshrw-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'dshrw-btn is-danger', disabled: busy, onClick: () => void apply(point.seq) },
                    busy ? t('working') : t('confirm'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dshrw-btn', disabled: busy, onClick: () => setConfirmSeq(null) },
                    t('cancel'),
                  ),
                ),
              )
            : null,
        )
      }

      const list =
        points.length === 0
          ? h('div', { className: 'dshrw-empty', key: 'empty' }, loading ? t('loading') : t('empty'))
          : h(
              'div',
              { className: 'dshrw-list', key: 'list' },
              [...points]
                .sort((a, b) => b.seq - a.seq)
                .slice(0, MAX_ROWS)
                .map((point) => renderRow(point)),
            )

      const panel = h(
        'div',
        { className: 'dshrw-panel', key: 'panel' },
        h(
          'div',
          { className: 'dshrw-head' },
          h('h4', { className: 'dshrw-title' }, t('title')),
          h('span', { className: 'dshrw-sub' }, t('subtitle')),
          h('span', { className: 'dshrw-spacer' }),
          h('button', { type: 'button', className: 'dshrw-btn', disabled: loading, onClick: () => void load(false) }, t('refresh')),
        ),
        list,
      )

      return h('div', { className: 'dshrw-root' }, h('style', null, CSS), bar, panel)
    }

    function apply(ctx) {
      t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'rewind: dictionaries')
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'rewind',
            // 排在 queue(0)/goal(10) 之后：这三条都只在有内容时才占位。
            order: 20,
            locale: NS,
          },
          RewindDock,
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
