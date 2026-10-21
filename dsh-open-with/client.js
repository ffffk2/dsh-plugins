/**
 * 通用「用其他应用打开工作区」——Client 半。
 *
 * 在会话头部 utilities 插槽里放一个紧凑按钮：图标是上次用过的应用，
 * 点它直接用该应用打开当前会话的工作区；带下拉箭头，列出配置里所有本机可用的应用。
 * 应用清单、图标、启动全部来自同包 Host 半的三条路由，所以「加一个新打开方式」
 * 只在 profile 配置里加一行，这里一个字都不用改。
 *
 * 只用宿主主题 token（--dsw-alias-*）着色，不引入任何 Harness Client 包，
 * 只 require('react')。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-open-with',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'open-with'

    /** 浏览器相对路径（不写开头的 /，与宿主其它插件的相对路由习惯一致）。 */
    const APPS_ROUTE = 'open-with/apps'
    const ICON_ROUTE = 'open-with/icon'
    const OPEN_ROUTE = 'open-with/open'

    /** 记住上次选择，跨会话、跨刷新。 */
    const CHOICE_KEY = 'dsh.open-with.choice'

    const zh = {
      'action.open': '用 {app} 打开工作区',
      'action.more': '更多打开方式',
      'action.default': '{app}（默认）',
      'action.none': '没有可用的应用',
      'action.failed': '打开失败，请重试',
      'action.loading': '正在探测本机应用…',
      'action.unavailable': '当前工作区不可用',
    }
    const en = {
      'action.open': 'Open workspace in {app}',
      'action.more': 'More ways to open',
      'action.default': '{app} (default)',
      'action.none': 'No applications available',
      'action.failed': 'Could not open. Try again.',
      'action.loading': 'Detecting local applications…',
      'action.unavailable': 'Current workspace unavailable',
    }

    const CSS = `
.dshto-anchor { position:relative; flex:none; align-self:center; display:inline-flex; }
.dshto-split { box-sizing:border-box; display:inline-flex; align-items:stretch; height:24px; overflow:hidden;
  border:1px solid var(--dsw-alias-border-l3); border-radius:8px; background:transparent; }
.dshto-main, .dshto-chevron { display:inline-flex; align-items:center; justify-content:center; gap:4px;
  border:0; background:transparent; color:var(--dsw-alias-label-primary); cursor:pointer; font-family:inherit;
  font-size:11px; line-height:16px; white-space:nowrap; padding:0 6px; }
.dshto-chevron { padding:0 4px; color:var(--dsw-alias-label-secondary); border-left:1px solid var(--dsw-alias-border-l2); }
.dshto-main:hover:not(:disabled), .dshto-chevron:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.dshto-main:disabled, .dshto-chevron:disabled { cursor:default; opacity:.55; }
.dshto-main:focus-visible, .dshto-chevron:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px; }
.dshto-icon { object-fit:contain; flex:none; display:block; }
.dshto-menu { position:absolute; top:calc(100% + 6px); right:0; z-index:120; min-width:200px; max-width:300px;
  padding:4px; display:flex; flex-direction:column;
  border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1);
  box-shadow:0 8px 26px var(--dsw-alias-bg-mask-1); }
.dshto-item { display:flex; align-items:center; gap:8px; width:100%; padding:6px 8px; border:0; border-radius:7px;
  background:transparent; color:var(--dsw-alias-label-primary); font-family:inherit; font-size:12px;
  text-align:left; cursor:pointer; }
.dshto-item:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.dshto-item.is-preferred { color:var(--dsw-alias-brand-primary); font-weight:600; }
.dshto-item:disabled { cursor:default; opacity:.55; }
.dshto-item-label { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshto-empty { padding:8px 10px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dshto-toast { position:absolute; top:calc(100% + 6px); right:0; z-index:121; padding:6px 10px; border-radius:8px;
  font-size:11.5px; white-space:nowrap; color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-state-error-primary); background:var(--dsw-alias-bg-layer-1);
  box-shadow:0 8px 26px var(--dsw-alias-bg-mask-1); }
`

    /** 注入一次样式，按插件 id 打标避免重复。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      const tagId = '@local/dsh-open-with/open-with.css'
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-open-with'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** 读上次选择，localStorage 不可用时当作没选过。 */
    function readChoice() {
      try {
        const value = window.localStorage.getItem(CHOICE_KEY)
        return typeof value === 'string' ? value : ''
      } catch {
        return ''
      }
    }

    function writeChoice(id) {
      try {
        window.localStorage.setItem(CHOICE_KEY, id)
      } catch {
        /* 隐私模式写不进去就算了，下次退回第一个 */
      }
    }

    /**
     * 页面级的应用清单：只读一次，失败就当作空列表（不渲染按钮）。
     *
     * 用模块级变量而不是 context，是因为这个按钮可能同时出现在多个位置，
     * 而清单在页面生命周期内不会变（Host 侧解析结果也是每进程一次）。
     */
    const appsStore = {
      value: null,
      loading: null,
      listeners: new Set(),
      subscribe(listener) {
        appsStore.listeners.add(listener)
        return () => {
          appsStore.listeners.delete(listener)
        }
      },
      publish(value) {
        appsStore.value = value
        for (const listener of appsStore.listeners) listener()
      },
      load() {
        if (appsStore.loading !== null) return appsStore.loading
        appsStore.loading = fetch(APPS_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : { apps: [] }))
          .then((payload) => {
            const list = Array.isArray(payload?.apps) ? payload.apps : []
            appsStore.publish(
              list
                .filter((entry) => typeof entry?.id === 'string' && entry.id !== '')
                .map((entry) => ({ id: entry.id, label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.id })),
            )
          })
          .catch(() => {
            appsStore.publish([])
          })
        return appsStore.loading
      },
    }

    /** 订阅应用清单（useSyncExternalStore，React 18）。 */
    function useApps() {
      const snapshot = React.useCallback(() => appsStore.value, [])
      const value = React.useSyncExternalStore(appsStore.subscribe, snapshot, snapshot)
      React.useEffect(() => {
        if (appsStore.value === null) appsStore.load()
      }, [])
      return value
    }

    /** 应用图标；加载失败回落到内联占位图形，不留下破图。 */
    function AppIcon(props) {
      const [broken, setBroken] = React.useState(false)
      React.useEffect(() => {
        setBroken(false)
      }, [props.appId])
      if (broken) return h(PlaceholderIcon, { size: props.size })
      return h('img', {
        className: 'dshto-icon',
        src: `${ICON_ROUTE}/${encodeURIComponent(props.appId)}`,
        width: props.size,
        height: props.size,
        alt: '',
        draggable: false,
        onError: () => setBroken(true),
      })
    }

    /** 没有图标时的通用「在新窗口打开」图形。 */
    function PlaceholderIcon(props) {
      const size = props.size ?? 14
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' },
        h('path', { d: 'M9.5 2.5h4v4', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M13.5 2.5 8 8', strokeLinecap: 'round' }),
        h('path', { d: 'M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /**
     * 会话头部的打开按钮。
     * @param props.sessionId - 宿主注入的当前会话 id。
     * @param props.useSessions - 宿主注入的会话快照选择器。
     * @param props.t - 本命名空间的翻译函数。
     */
    function OpenWithButton(props) {
      const { sessionId, useSessions, t } = props
      const cwd = typeof useSessions === 'function' ? useSessions((sessions) => sessions?.byId?.[sessionId]?.cwd) : undefined
      const apps = useApps()

      const [menuOpen, setMenuOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [choice, setChoice] = React.useState(readChoice)
      const anchorRef = React.useRef(null)

      // 菜单开着时点外面或按 Esc 关掉。
      React.useEffect(() => {
        if (!menuOpen) return undefined
        const onPointerDown = (event) => {
          if (anchorRef.current !== null && !anchorRef.current.contains(event.target)) setMenuOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setMenuOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [menuOpen])

      if (apps === null || apps.length === 0) return null

      const preferred = apps.find((app) => app.id === choice) ?? apps[0]
      const disabled = busy || typeof cwd !== 'string' || cwd === ''

      /**
       * 启动一个应用。
       * @param appId - 应用 id。
       * @param remember - 是否记住这次选择（菜单里点选才记，主按钮不记）。
       */
      const launch = (appId, remember) => {
        setMenuOpen(false)
        if (busy) return
        setBusy(true)
        setFailure(null)
        fetch(OPEN_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app: appId, path: cwd }),
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
            if (remember) {
              writeChoice(appId)
              setChoice(appId)
            }
          })
          .catch(() => {
            setFailure(t('action.failed'))
          })
          .finally(() => {
            setBusy(false)
          })
      }

      const label = t('action.open', { app: preferred.label })

      return h(
        'div',
        { className: 'dshto-anchor', ref: anchorRef },
        h(
          'div',
          { className: 'dshto-split', 'data-open-with': preferred.id, 'data-state': busy ? 'busy' : 'idle' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshto-main',
              disabled,
              title: disabled ? t('action.unavailable') : label,
              'aria-label': label,
              onClick: () => launch(preferred.id, false),
            },
            h(AppIcon, { appId: preferred.id, size: 14 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshto-chevron',
              disabled: busy,
              'aria-haspopup': 'menu',
              'aria-expanded': menuOpen,
              'aria-label': t('action.more'),
              title: t('action.more'),
              onClick: () => setMenuOpen((open) => !open),
            },
            h(
              'svg',
              { width: 10, height: 10, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': 'true' },
              h('path', { d: 'm4 6 4 4 4-4', strokeLinecap: 'round', strokeLinejoin: 'round' }),
            ),
          ),
        ),
        menuOpen
          ? h(
              'div',
              { className: 'dshto-menu', role: 'menu' },
              ...apps.map((app) =>
                h(
                  'button',
                  {
                    key: app.id,
                    type: 'button',
                    role: 'menuitem',
                    className: app.id === preferred.id ? 'dshto-item is-preferred' : 'dshto-item',
                    onClick: () => launch(app.id, true),
                  },
                  h(AppIcon, { appId: app.id, size: 14 }),
                  h('span', { className: 'dshto-item-label' }, app.id === preferred.id ? t('action.default', { app: app.label }) : app.label),
                ),
              ),
            )
          : null,
        failure === null ? null : h('div', { className: 'dshto-toast', role: 'status' }, failure),
      )
    }

    function apply(ctx) {
      ensureStyle()
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'open-with: dictionaries')
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: 'open-with',
                // 排在官方「打开方式」（order -10）右边一格。
                order: -9,
                locale: NS,
              },
              OpenWithButton,
            ),
          ),
        'open-with: session header button',
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
