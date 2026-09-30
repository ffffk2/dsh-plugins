/**
 * Git —— Client 半。
 *
 * 在右侧栏注册一个 tab 类型（kind = 'git'，id = '@local/dsh-git'），
 * 参照 VS Code 的源代码管理面板做可视化 Git 操作：
 *
 *   ① 变更区：暂存的更改 / 更改 两组，行内 hover 出「+ / − / ↺」按钮
 *   ② 提交框：输入信息 + 提交按钮，Ctrl+Enter 提交；有暂存项才能提交
 *   ③ 差异视图：点文件就地展开 unified diff，绿加红删、带行号与 hunk 头
 *   ④ 历史：按页加载的提交列表，点开看详情与该次提交的文件
 *   ⑤ 分支：本地/远程分支、切换、新建、删除，ahead/behind 提示
 *   ⑥ 远程：fetch / pull / push，无上游时给「发布分支」
 *   ⑦ 仓库选择：当前会话工作目录不是仓库时，可手动输入/选择路径
 *
 * 数据全部来自同包 Host 半的 /git/* 路由（见 index.js）。UI 只用宿主主题 token
 * （--dsw-alias-*）着色，不引入任何 Harness Client 包，只 require('react')。
 *
 * 关于「为什么用右侧栏 tab 而不是设置页」：宿主把右侧栏做成 tab 类型注册表
 * （ctx.sidebarRightTabs.register + slots 的 sidebar.right.pane.tab），
 * 浏览器/文档预览都走这条路；Git 与它们同级，才能出现在同一个 guide 卡片列表里、
 * 支持多开与分屏。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-git',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** tab 类型标识：kind 决定 slots 的派发键，id 决定注册表身份。 */
    const GIT_KIND = 'git'
    const GIT_ID = '@local/dsh-git'
    const NS = 'git'

    const STATUS_PATH = '/git/status'
    const DIFF_PATH = '/git/diff'
    const LOG_PATH = '/git/log'
    const COMMIT_PATH = '/git/commit'
    const BRANCHES_PATH = '/git/branches'
    const ACTION_PATH = '/git/action'

    /** 历史每页条数。 */
    const LOG_PAGE = 50
    /** 差异视图一次最多渲染的行数，超出提示折叠，避免长文件把 DOM 撑爆。 */
    const MAX_RENDER_LINES = 3000

    const zh = {
      'type.label': 'Git',
      'guide.title': 'Git',
      'guide.description': '可视化提交、分支与差异',
      title: '源代码管理',
      changes: '更改',
      stagedChanges: '暂存的更改',
      history: '历史',
      branches: '分支',
      remotes: '远程',
      refresh: '刷新',
      stage: '暂存更改',
      unstage: '取消暂存',
      discard: '放弃更改',
      discardConfirm: '放弃 {file} 的本地修改？此操作不可撤销。',
      deleteUntracked: '删除文件',
      deleteUntrackedConfirm: '删除未跟踪的文件 {file}？文件会从磁盘上移除，此操作不可撤销。',
      discardAll: '全部丢弃',
      discardAllConfirm: '放弃所有更改？已跟踪文件还原到上次提交，未跟踪文件将被删除（被 .gitignore 忽略的文件保留）。此操作不可撤销。',
      discardAllOk: '已丢弃全部更改',
      stageAll: '全部暂存',
      unstageAll: '全部取消暂存',
      commitMessage: '消息（Ctrl+Enter 提交）',
      commit: '提交',
      commitAmend: '修改上次提交',
      committing: '提交中…',
      noStaged: '暂存一些更改后即可提交',
      clean: '没有检测到更改',
      cleanHint: '工作区干净。继续写代码吧。',
      loading: '加载中…',
      notRepo: '当前目录不是 Git 仓库',
      notRepoHint: '换个路径，或在这里初始化一个新仓库。',
      repoPath: '仓库路径',
      open: '打开',
      init: '初始化仓库',
      initing: '初始化中…',
      failed: '操作失败：',
      diffEmpty: '没有可显示的差异（可能是二进制文件或纯模式变更）。',
      diffTruncated: '差异过长，已截断显示。',
      binary: '二进制文件，无法显示差异。',
      fetch: '获取',
      pull: '拉取',
      push: '推送',
      publish: '发布分支',
      fetchOk: '已获取远程更新',
      pullOk: '已拉取',
      pushOk: '已推送',
      working: '执行中…',
      ahead: '领先 {n}',
      behind: '落后 {n}',
      noUpstream: '无上游分支',
      current: '当前',
      checkout: '切换',
      createBranch: '新建分支',
      newBranchPlaceholder: '新分支名（空格自动变 -）',
      startPoint: '起点分支',
      startPointHead: '当前 HEAD',
      merge: '合并到当前分支',
      mergeFastForward: '允许快进',
      mergeNoFf: '强制合并提交',
      mergeConfirm: '把 {name} 合并到 {current}？',
      mergeOk: '已合并',
      mergeConflict: '合并有冲突，请在文件里解决后暂存并提交；也可以放弃合并。',
      merging: '合并进行中',
      mergeAbort: '放弃合并',
      create: '创建',
      cancel: '取消',
      delete: '删除',
      deleteBranchConfirm: '删除分支 {name}？',
      stash: '贮藏',
      stashSave: '贮藏更改',
      stashPop: '恢复贮藏并删除',
      stashApply: '应用贮藏（保留）',
      stashDrop: '删除贮藏',
      stashPick: '选择要操作的贮藏',
      stashApplyConfirm: '应用 {ref}（{message}）？工作区会合并进它的内容，该贮藏仍保留。',
      stashPopConfirm: '恢复 {ref}（{message}）并从贮藏列表里删除？',
      stashDropConfirm: '删除贮藏 {ref}（{message}）？此操作不可撤销。',
      stashApplyOk: '已应用贮藏',
      stashPopOk: '已恢复贮藏',
      stashNoMessage: '（无说明）',
      noCommits: '还没有任何提交。',
      graphTruncated: '泳道图在此截断：上面还有未加载的提交，点「加载更多」接上。',
      loadMore: '加载更多',
      by: '作者',
      filesChanged: '{n} 个文件',
      viewCommit: '查看此次提交',
      closeDiff: '关闭差异',
      commitFiles: '本次改动的文件',
      back: '返回历史',
      detached: '游离 HEAD',
      untracked: '未跟踪',
      modified: '已修改',
      added: '已新增',
      deleted: '已删除',
      renamed: '已重命名',
      conflicted: '有冲突',
      stats: '{n} 个更改',
      noBranches: '没有分支。',
      localBranches: '本地',
      remoteBranches: '远程',
      rootLabel: '仓库',
      tabTitle: 'Git',
      actionFailedNoMessage: '操作没有返回信息',
      actionTimeout: '命令超时被中断，结果未知——改动可能已经生效，请先看工作区再决定是否重试。',
      actionFailedCode: 'git 以退出码 {code} 结束，但没有输出错误信息。',
      actionConflict: 'git 报了冲突，动作没能干净结束：{n} 个文件需要手动解决（{files}）。冲突内容已经写进工作区了，不是没生效；解决后再暂存/提交。',
      pickPath: '选择文件夹',
      dirtyTip: '有未提交的更改，切换分支可能失败',
    }

    const en = {
      'type.label': 'Git',
      'guide.title': 'Git',
      'guide.description': 'Commit, branch, and diff visually',
      title: 'Source Control',
      changes: 'Changes',
      stagedChanges: 'Staged Changes',
      history: 'History',
      branches: 'Branches',
      remotes: 'Remotes',
      refresh: 'Refresh',
      stage: 'Stage changes',
      unstage: 'Unstage changes',
      discard: 'Discard changes',
      discardConfirm: 'Discard local changes to {file}? This cannot be undone.',
      deleteUntracked: 'Delete file',
      deleteUntrackedConfirm: 'Delete the untracked file {file}? It will be removed from disk. This cannot be undone.',
      discardAll: 'Discard all',
      discardAllConfirm: 'Discard all changes? Tracked files go back to the last commit and untracked files are deleted (files matching .gitignore are kept). This cannot be undone.',
      discardAllOk: 'Discarded all changes',
      stageAll: 'Stage all',
      unstageAll: 'Unstage all',
      commitMessage: 'Message (Ctrl+Enter to commit)',
      commit: 'Commit',
      commitAmend: 'Amend last commit',
      committing: 'Committing…',
      noStaged: 'Stage some changes to commit',
      clean: 'No changes detected',
      cleanHint: 'The working tree is clean.',
      loading: 'Loading…',
      notRepo: 'This folder is not a Git repository',
      notRepoHint: 'Try another path, or initialize a repository here.',
      repoPath: 'Repository path',
      open: 'Open',
      init: 'Initialize repository',
      initing: 'Initializing…',
      failed: 'Failed: ',
      diffEmpty: 'No diff to show (binary file or mode-only change).',
      diffTruncated: 'The diff was truncated.',
      binary: 'Binary file; no diff to display.',
      fetch: 'Fetch',
      pull: 'Pull',
      push: 'Push',
      publish: 'Publish branch',
      fetchOk: 'Fetched remote updates',
      pullOk: 'Pulled',
      pushOk: 'Pushed',
      working: 'Working…',
      ahead: '{n} ahead',
      behind: '{n} behind',
      noUpstream: 'No upstream',
      current: 'current',
      checkout: 'Checkout',
      createBranch: 'New branch',
      newBranchPlaceholder: 'New branch name (spaces become -)',
      startPoint: 'Start point',
      startPointHead: 'Current HEAD',
      merge: 'Merge into current branch',
      mergeFastForward: 'Allow fast-forward',
      mergeNoFf: 'Always create a merge commit',
      mergeConfirm: 'Merge {name} into {current}?',
      mergeOk: 'Merged',
      mergeConflict: 'The merge has conflicts. Resolve them in the files, then stage and commit; or abort the merge.',
      merging: 'Merge in progress',
      mergeAbort: 'Abort merge',
      create: 'Create',
      cancel: 'Cancel',
      delete: 'Delete',
      deleteBranchConfirm: 'Delete branch {name}?',
      stash: 'Stashes',
      stashSave: 'Stash changes',
      stashPop: 'Restore and drop',
      stashApply: 'Apply stash (keep)',
      stashDrop: 'Drop stash',
      stashPick: 'Choose a stash',
      stashApplyConfirm: 'Apply {ref} ({message})? Its content is merged into the working tree and the stash is kept.',
      stashPopConfirm: 'Restore {ref} ({message}) and remove it from the stash list?',
      stashDropConfirm: 'Drop stash {ref} ({message})? This cannot be undone.',
      stashApplyOk: 'Stash applied',
      stashPopOk: 'Stash restored',
      stashNoMessage: '(no message)',
      noCommits: 'No commits yet.',
      graphTruncated: 'Graph is cut off here: earlier commits are not loaded yet. Use "Load more" to continue.',
      loadMore: 'Load more',
      by: 'by',
      filesChanged: '{n} files',
      viewCommit: 'View this commit',
      closeDiff: 'Close diff',
      commitFiles: 'Files in this commit',
      back: 'Back to history',
      detached: 'Detached HEAD',
      untracked: 'Untracked',
      modified: 'Modified',
      added: 'Added',
      deleted: 'Deleted',
      renamed: 'Renamed',
      conflicted: 'Conflicted',
      stats: '{n} changes',
      noBranches: 'No branches.',
      localBranches: 'Local',
      remoteBranches: 'Remote',
      rootLabel: 'Repository',
      tabTitle: 'Git',
      actionFailedNoMessage: 'The operation returned no message',
      actionTimeout: 'The command timed out and was interrupted, so the result is unknown — it may already have taken effect. Check the working tree before retrying.',
      actionFailedCode: 'git exited with code {code} but produced no error output.',
      actionConflict: 'git reported conflicts, so the action did not finish cleanly: {n} file(s) need manual resolution ({files}). The conflicting content is already in the working tree — resolve it, then stage and commit.',
      pickPath: 'Pick folder',
      dirtyTip: 'Uncommitted changes may block a checkout',
    }

    // 由 apply 绑定的翻译函数；组件渲染时读取。
    let t = (key) => key

    /** 把 {n} / {file} 这类占位符替换掉。 */
    function fmt(key, values) {
      let text = t(key)
      if (values === undefined) return text
      for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(String(value))
      return text
    }

    const CSS = `
.dshg-root { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); font-size:13px; background:var(--dsw-alias-bg-base); }
.dshg-root *, .dshg-root *::before, .dshg-root *::after { box-sizing:border-box; }

/* 顶部：分支 + 远程动作 */
.dshg-top { display:flex; align-items:center; gap:6px; padding:8px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; flex-wrap:wrap; }
.dshg-branch-btn { display:inline-flex; align-items:center; gap:5px; height:26px; padding:0 9px; max-width:200px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary); font-size:12px; cursor:pointer; }
.dshg-branch-btn:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dshg-branch-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshg-spacer { flex:1 1 auto; }

.dshg-btn { height:26px; padding:0 9px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-secondary); font-size:12px; cursor:pointer; display:inline-flex; align-items:center; gap:5px; }
.dshg-btn:hover:not([disabled]) { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dshg-btn[disabled] { opacity:.4; cursor:default; }
.dshg-btn.is-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); }
.dshg-btn.is-primary:hover:not([disabled]) { opacity:.86; color:var(--dsw-alias-bg-base); }
.dshg-btn.is-on { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dshg-btn.is-icon { width:24px; height:24px; padding:0; justify-content:center; font-size:13px; border-color:transparent; }
.dshg-btn.is-icon:hover:not([disabled]) { background:var(--dsw-alias-bg-layer-2); }
/* 删除/丢弃类动作：hover 时用错误色，和「暂存」「新建」这类安全动作区分开。 */
.dshg-btn.is-danger:hover:not([disabled]) { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }

/* 计数器徽标 */
.dshg-count { min-width:17px; height:17px; padding:0 5px; border-radius:9px; font-size:10px; line-height:17px; text-align:center; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dshg-count.is-brand { background:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); }

/* 滚动区 */
.dshg-scroll { flex:1 1 auto; min-height:0; overflow:auto; }

/* 提交框 */
.dshg-commit-box { padding:8px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; }
.dshg-textarea { width:100%; min-height:62px; max-height:180px; resize:vertical; padding:7px 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-family:var(--ds-font-family, inherit); font-size:12px; line-height:1.5; }
.dshg-textarea:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.dshg-textarea::placeholder { color:var(--dsw-alias-label-secondary); }
.dshg-commit-actions { display:flex; align-items:center; gap:6px; margin-top:7px; flex-wrap:wrap; }

/* 分组标题 */
.dshg-section { border-bottom:1px solid var(--dsw-alias-border-l1); }
.dshg-section-head { display:flex; align-items:center; gap:6px; padding:6px 10px; cursor:pointer; user-select:none; }
.dshg-section-head:hover { background:var(--dsw-alias-bg-layer-2); }
.dshg-caret { width:10px; font-size:9px; color:var(--dsw-alias-label-secondary); transition:transform .15s; }
.dshg-caret.is-open { transform:rotate(90deg); }
.dshg-section-title { font-size:11px; font-weight:600; letter-spacing:.03em; text-transform:uppercase; color:var(--dsw-alias-label-secondary); }

/* 文件行 */
.dshg-file { display:flex; align-items:center; gap:6px; padding:3px 10px 3px 18px; cursor:pointer; }
.dshg-file:hover { background:var(--dsw-alias-bg-layer-2); }
.dshg-file.is-active { background:var(--dsw-alias-bg-layer-2); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.dshg-file-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; font-size:12px; }
.dshg-file-dir { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dshg-file-actions { display:none; align-items:center; gap:2px; flex:0 0 auto; }
.dshg-file:hover .dshg-file-actions { display:inline-flex; }
.dshg-letter { width:14px; text-align:center; font-size:11px; font-weight:700; flex:0 0 auto; font-variant-numeric:tabular-nums; }
.dshg-k-modified { color:var(--dsw-alias-state-warn-primary); }
.dshg-k-added, .dshg-k-untracked { color:var(--dsw-alias-state-success-primary); }
.dshg-k-deleted { color:var(--dsw-alias-state-error-primary); }
.dshg-k-renamed { color:var(--dsw-alias-state-business-primary); }
.dshg-k-conflicted { color:var(--dsw-alias-state-error-primary); }

/* 差异视图 */
.dshg-diff { border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.dshg-diff-head { display:flex; align-items:center; gap:6px; padding:5px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); position:sticky; top:0; background:var(--dsw-alias-bg-layer-1); z-index:2; }
.dshg-diff-path { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshg-diff-body { font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:11.5px; line-height:1.55; overflow-x:auto; }
.dshg-line { display:flex; white-space:pre; min-width:max-content; }
.dshg-ln { flex:0 0 auto; width:44px; padding-right:8px; text-align:right; color:var(--dsw-alias-label-secondary); user-select:none; opacity:.7; font-variant-numeric:tabular-nums; }
.dshg-lt { flex:1 1 auto; padding-right:10px; }
.dshg-add { background:var(--dsw-alias-bg-layer-2); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); }
.dshg-add .dshg-lt { color:var(--dsw-alias-state-success-primary); }
.dshg-del { background:var(--dsw-alias-bg-layer-2); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent); }
.dshg-del .dshg-lt { color:var(--dsw-alias-state-error-primary); }
.dshg-hunk { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-state-business-primary); }
.dshg-meta { color:var(--dsw-alias-label-secondary); }
.dshg-empty { padding:14px 12px; font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.6; }
.dshg-error { margin:8px 10px; padding:8px 10px; border-radius:8px; font-size:11.5px; line-height:1.5; color:var(--dsw-alias-state-error-primary); border:1px solid var(--dsw-alias-state-error-primary); background:var(--dsw-alias-bg-layer-2); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); word-break:break-word; }
.dshg-ok { margin:8px 10px; padding:8px 10px; border-radius:8px; font-size:11.5px; color:var(--dsw-alias-state-success-primary); border:1px solid var(--dsw-alias-state-success-primary); background:var(--dsw-alias-bg-layer-2); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); word-break:break-word; }

/* 提交列表 */
.dshg-commit { display:flex; gap:8px; padding:6px 10px; cursor:pointer; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dshg-commit:hover { background:var(--dsw-alias-bg-layer-2); }
/* 泳道图：整格是一列列竖线，节点压在线上。行高由右侧内容撑开，
   所以上下两半都用 flex 平分，线才能首尾对齐、跨行连成一条。 */
.dshg-graph { flex:0 0 auto; position:relative; align-self:stretch; min-height:34px; }
.dshg-graph-half { position:absolute; left:0; right:0; height:50%; }
.dshg-graph-half.is-top { top:0; }
.dshg-graph-half.is-bottom { bottom:0; }
.dshg-thread { position:absolute; top:0; bottom:0; width:2px; margin-left:-1px; background:var(--dsw-alias-border-l2); }
/* 主线（第一个父提交那条）用品牌色，和别的分支区分开 */
.dshg-thread.is-main { background:var(--dsw-alias-brand-primary); opacity:.55; }
.dshg-graph-join { position:absolute; top:0; height:2px; background:var(--dsw-alias-border-l2); }
.dshg-node { position:absolute; top:50%; width:8px; height:8px; margin:-5px 0 0 -5px; border-radius:50%; background:var(--dsw-alias-bg-base); border:2px solid var(--dsw-alias-border-l2); box-sizing:border-box; }
/* 主角：当前 HEAD 那一行的节点放大、实心、用品牌色 */
.dshg-node.is-head { width:10px; height:10px; margin:-6px 0 0 -6px; background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dshg-commit-main { flex:1 1 auto; min-width:0; }
.dshg-subject { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshg-commit-meta { display:flex; gap:8px; margin-top:2px; font-size:10.5px; color:var(--dsw-alias-label-secondary); flex-wrap:wrap; }
.dshg-hash { font-family:var(--ds-font-family-mono, ui-monospace, monospace); color:var(--dsw-alias-state-business-primary); }
.dshg-ref { font-size:10px; padding:0 5px; height:15px; line-height:15px; border-radius:7px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); }
.dshg-ref.is-head { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); font-weight:600; }
/* 图被分页截断时的提示：贴在列表尾，做成弱化的脚注而不是错误。 */
.dshg-graph-note { padding:8px 12px 8px 30px; font-size:10.5px; line-height:1.5; color:var(--dsw-alias-label-secondary); border-bottom:1px dashed var(--dsw-alias-border-l2); }

/* 分支列表 */
.dshg-branch { display:flex; align-items:center; gap:6px; padding:5px 10px; cursor:pointer; }
.dshg-branch:hover { background:var(--dsw-alias-bg-layer-2); }
.dshg-branch-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
.dshg-branch.is-current .dshg-branch-name { font-weight:600; color:var(--dsw-alias-brand-primary); }
.dshg-branch-actions { display:none; gap:2px; }
.dshg-branch:hover .dshg-branch-actions { display:inline-flex; }
.dshg-inline-form { display:flex; gap:6px; padding:7px 10px; align-items:center; }
.dshg-input { flex:1 1 auto; min-width:0; height:26px; padding:0 8px; border-radius:7px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:12px; }
.dshg-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }

/* 空状态 / 仓库选择 */
.dshg-center { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:28px 18px; text-align:center; }
.dshg-center-title { font-size:13px; font-weight:600; }
.dshg-center-hint { font-size:11.5px; color:var(--dsw-alias-label-secondary); line-height:1.6; max-width:320px; }
.dshg-tabs { display:flex; gap:2px; padding:6px 10px 0; border-bottom:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; }
.dshg-tab { height:26px; padding:0 10px; border:none; border-bottom:2px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary); font-size:12px; cursor:pointer; }
.dshg-tab:hover { color:var(--dsw-alias-label-primary); }
.dshg-tab.is-on { color:var(--dsw-alias-brand-primary); border-bottom-color:var(--dsw-alias-brand-primary); }
.dshg-sync { display:flex; align-items:center; gap:6px; font-size:10.5px; color:var(--dsw-alias-label-secondary); }
/* 贮藏区：位于「更改」区块顶部。标题 + 下拉选择，下面是应用/恢复/删除按钮。
   用下边框与下面的文件列表分隔（它现在在区块内部，不再是提交框的一部分）。 */
.dshg-stash { display:flex; flex-direction:column; gap:6px; padding:7px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dshg-stash-row { display:flex; align-items:center; gap:6px; }
.dshg-stash-title { font-size:10.5px; color:var(--dsw-alias-label-secondary); flex:0 0 auto; }
.dshg-stash-select { flex:1 1 auto; min-width:0; height:24px; font-size:11.5px; cursor:pointer; }
.dshg-stash-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
`

    // ---- 纯函数工具 ----

    /** 把 fetch 的响应转成 JSON，非 2xx 抛错。 */
    async function readJson(response) {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    function statusLetter(kind) {
      switch (kind) {
        case 'added':
          return 'A'
        case 'untracked':
          return 'U'
        case 'deleted':
          return 'D'
        case 'renamed':
          return 'R'
        case 'conflicted':
          return '!'
        default:
          return 'M'
      }
    }

    function kindLabel(kind) {
      switch (kind) {
        case 'added':
          return t('added')
        case 'untracked':
          return t('untracked')
        case 'deleted':
          return t('deleted')
        case 'renamed':
          return t('renamed')
        case 'conflicted':
          return t('conflicted')
        default:
          return t('modified')
      }
    }

    /** 把 'a/b/c.txt' 拆成目录与文件名，目录用于弱化显示。 */
    function splitPath(path) {
      const index = path.lastIndexOf('/')
      if (index < 0) return { dir: '', name: path }
      return { dir: path.slice(0, index + 1), name: path.slice(index + 1) }
    }

    /** ISO 时间 → 本地可读，失败就原样返回。 */
    function formatDate(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }

    /**
     * 把用户手写的分支名整理成 git 认得的形态：空白换成中划线，并折叠连续的中划线。
     *
     * 出现的场合是「输入框 onChange」，所以必须逐字符幂等——用户按一次空格就立刻看到
     * 一个 `-`，继续按也只是保持一个 `-`，不会出现「删掉一个中划线、光标却被吞字符」的错位。
     * 只动空白与中划线，不碰 `/`（feature/x 这类分层名是合法且常用的）、`_`、`.` 和中文，
     * 非法字符交给 git 自己报错，免得把用户的名字悄悄改成别的东西。
     * @param value - 输入框当前内容。
     * @returns 规范化后的分支名。
     */
    function sanitizeBranchName(value) {
      return String(value ?? '')
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
    }

    /** 泳道最大列数：再多也没人看得懂，超出的一律并到最后一列。 */
    const MAX_LANES = 6

    /**
     * 把提交列表算成多泳道拓扑图（每个提交占一行，行内有多条竖线与节点）。
     *
     * 输入是 `git log` 的顺序（新→旧），这是关键前提：处理一个提交时，
     * 它的父提交一定还在后面，所以「谁接着谁」可以靠一次前向扫描定下来。
     *
     * 算法：维护 lanes 数组，每格是「一条竖线在等着哪个 commit hash」。
     *   - 当前提交在 lanes 里占哪一列，就是它的泳道；同一 hash 可能占多列
     *     （merge 的两个父各自被别的分支占着），全部收拢到最左那列显示。
     *   - 收拢后，把这些格子都改指向它的父提交（第一个父留原列 = 主线延续，
     *     其余父插新列 = 分叉），并把重复指向同一 hash 的格子清掉（避免两条线叠在一条上）。
     *
     * 分页的坑：只看一页数据时，父提交可能还没加载，竖线到这里就断了。
     * 所以返回 truncated 标记，由界面提示「还有更多」，而不是假装图是完整的。
     *
     * @param commits - 提交数组，新→旧；每项需有 hash 与 parents。
     * @returns {{rows: Array, laneCount: number, truncated: boolean}} rows 与 commits 等长，
     *   每项是 { lane, lanes: Array<string|null>, parents: Array<number> }。
     */
    function buildGraph(commits) {
      const list = Array.isArray(commits) ? commits : []
      const known = new Set(list.map((commit) => commit.hash))
      let lanes = []
      const rows = []
      let laneCount = 0
      let truncated = false

      for (const commit of list) {
        const parents = Array.isArray(commit.parents) ? commit.parents : []

        // 找当前提交占用的列；一条都没有说明它是「新出现的线头」（例如当前分支的最新提交）。
        let mine = []
        for (let index = 0; index < lanes.length; index += 1) {
          if (lanes[index] === commit.hash) mine.push(index)
        }
        if (mine.length === 0) {
          // 插到最左的空位；没有空位就追加一列。上限之外统一挤在最后一列。
          const free = lanes.indexOf(null)
          const at = free === -1 ? lanes.length : free
          if (at >= MAX_LANES) {
            mine = [MAX_LANES - 1]
            truncated = true
          } else {
            if (free === -1) lanes.push(commit.hash)
            else lanes[free] = commit.hash
            mine = [at]
          }
        }
        const lane = Math.min(mine[0], MAX_LANES - 1)

        // 收拢：当前提交占的列全部腾出来，交给它的父提交接手。
        for (const index of mine) lanes[index] = null
        const parentLanes = []
        parents.forEach((parent, order) => {
          if (!known.has(parent)) {
            // 父提交不在本页里：留一条线表示「图还没完」，等加载更多再接上。
            truncated = true
            return
          }
          // 已有一列在等这个父提交，就并过去，别为一个提交铺两条线。
          const existing = lanes.indexOf(parent)
          if (existing !== -1) {
            parentLanes.push(Math.min(existing, MAX_LANES - 1))
            return
          }
          // 第一个父沿用它自己那一列（主线延续），其余父插空位（分叉）。
          let at = order === 0 ? lane : -1
          if (at === -1 || lanes[at] !== null) at = lanes.indexOf(null)
          if (at === -1) at = lanes.length
          if (at >= MAX_LANES) {
            parentLanes.push(MAX_LANES - 1)
            truncated = true
            return
          }
          if (at === lanes.length) lanes.push(parent)
          else lanes[at] = parent
          parentLanes.push(at)
        })
        // 尾部空列裁掉，泳道数才不会只增不减。
        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
        if (lanes.length > laneCount) laneCount = lanes.length

        rows.push({ lane, lanes: lanes.slice(), parents: parentLanes })
      }

      return { rows, laneCount: Math.min(Math.max(laneCount, 1), MAX_LANES), truncated }
    }

    /**
     * 把 unified diff 文本解析成可渲染的行。
     *
     * 只认 @@ 头来推进新旧行号，其余行按前缀判定增删。
     * `---`/`+++`/`diff --git`/`index` 这些头统一当 meta 灰掉，避免和增删行混在一起看错。
     * @param text - 原始 diff。
     * @returns 行对象数组 {type, sign, oldNo, newNo, text}。
     */
    function parseDiffLines(text) {
      const lines = []
      let oldNo = 0
      let newNo = 0
      for (const raw of String(text ?? '').split('\n')) {
        if (raw.startsWith('@@')) {
          const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
          if (match !== null) {
            oldNo = Number.parseInt(match[1], 10)
            newNo = Number.parseInt(match[2], 10)
          }
          lines.push({ type: 'hunk', sign: '', oldNo: '', newNo: '', text: raw })
          continue
        }
        if (
          raw.startsWith('diff --git') ||
          raw.startsWith('index ') ||
          raw.startsWith('--- ') ||
          raw.startsWith('+++ ') ||
          raw.startsWith('new file') ||
          raw.startsWith('deleted file') ||
          raw.startsWith('similarity index') ||
          raw.startsWith('rename ') ||
          raw.startsWith('old mode') ||
          raw.startsWith('new mode') ||
          raw.startsWith('Binary files')
        ) {
          lines.push({ type: 'meta', sign: '', oldNo: '', newNo: '', text: raw })
          continue
        }
        if (raw.startsWith('\\')) {
          lines.push({ type: 'meta', sign: '', oldNo: '', newNo: '', text: raw })
          continue
        }
        if (raw.startsWith('+')) {
          lines.push({ type: 'add', sign: '+', oldNo: '', newNo, text: raw.slice(1) })
          newNo += 1
          continue
        }
        if (raw.startsWith('-')) {
          lines.push({ type: 'del', sign: '-', oldNo, newNo: '', text: raw.slice(1) })
          oldNo += 1
          continue
        }
        if (raw.startsWith(' ')) {
          lines.push({ type: 'ctx', sign: ' ', oldNo, newNo, text: raw.slice(1) })
          oldNo += 1
          newNo += 1
          continue
        }
        // 末尾空串（trailing newline）不渲染，别的都当上下文。
        if (raw === '') continue
        lines.push({ type: 'ctx', sign: ' ', oldNo, newNo, text: raw })
        oldNo += 1
        newNo += 1
      }
      return lines
    }

    /** 差异统计：加了多少行、删了多少行。 */
    function diffStat(lines) {
      let add = 0
      let del = 0
      for (const line of lines) {
        if (line.type === 'add') add += 1
        else if (line.type === 'del') del += 1
      }
      return { add, del }
    }

    /**
     * 把一次失败的动作结果翻译成给人看的文案。
     *
     * 关键在于区分三种「失败」，它们的真相完全不同：
     *   - git 自己报了错：**一定**会往 stderr 写点什么（`error:` / `fatal:`），照抄即可，
     *     那是最有诊断价值的一手信息；
     *   - stderr 为空但 stdout 有内容：冲突类信息 git 全写 stdout（`git stash apply`
     *     撞上冲突就是「退出码 1 + stdout 有 CONFLICT + stderr 空」），而**改动已经
     *     写进工作区了**。不引用 stdout 的话，用户只会看到「退出码 1、没有输出」，
     *     于是以为白忙一场——实际恰恰相反；
     *   - stderr 与 stdout 都空：只可能是进程被超时/信号打断。这时原来的兜底文案
     *     「操作没有返回信息」把真相盖住了，所以显式说明「结果未知、改动可能已生效」，
     *     让用户先去看工作区，而不是直接重试——重试一次可能把改动叠加两遍。
     * @param result - Host 的动作响应。
     * @returns 展示用的错误文案。
     */
    function describeFailure(result) {
      const message = typeof result?.message === 'string' ? result.message.trim() : ''
      if (message !== '') return message
      if (result?.killed === true) return t('actionTimeout')
      const output = typeof result?.stdout === 'string' ? result.stdout.trim() : ''
      if (output !== '') {
        // 只取头几行：git 的冲突摘要动辄五六行，全塞进提示条会盖住整个列表。
        const lines = output.split('\n').map((line) => line.trim()).filter((line) => line !== '')
        return lines.length > 3 ? `${lines.slice(0, 3).join(' / ')} …` : lines.join(' / ')
      }
      if (typeof result?.code === 'number') return fmt('actionFailedCode', { code: result.code })
      return t('actionFailedNoMessage')
    }

    // ---- 数据访问 ----

    /** 组装带 path 的查询串。 */
    function withPath(path, extra) {
      const params = new URLSearchParams({ path })
      for (const [key, value] of Object.entries(extra ?? {})) {
        if (value !== undefined && value !== null) params.set(key, String(value))
      }
      return `?${params.toString()}`
    }

    const api = {
      status: (path) => fetch(`${STATUS_PATH}${withPath(path)}`, { headers: { accept: 'application/json' } }).then(readJson),
      diff: (path, file, options) =>
        fetch(`${DIFF_PATH}${withPath(path, { file, staged: options?.staged === true ? 'true' : undefined, commit: options?.commit })}`, {
          headers: { accept: 'application/json' },
        }).then(readJson),
      log: (path, options) =>
        fetch(`${LOG_PATH}${withPath(path, { limit: options?.limit ?? LOG_PAGE, skip: options?.skip ?? 0, branch: options?.branch, file: options?.file })}`, {
          headers: { accept: 'application/json' },
        }).then(readJson),
      commit: (path, hash) => fetch(`${COMMIT_PATH}${withPath(path, { hash })}`, { headers: { accept: 'application/json' } }).then(readJson),
      branches: (path) => fetch(`${BRANCHES_PATH}${withPath(path)}`, { headers: { accept: 'application/json' } }).then(readJson),
      action: (path, action, payload) =>
        fetch(ACTION_PATH, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ path, action, ...(payload ?? {}) }),
        }).then(readJson),
    }

    // ---- 子组件 ----

    /** 差异视图：解析后的行渲染，带行号与增删着色。 */
    function DiffView({ data, loading, error, onClose }) {
      const lines = React.useMemo(() => parseDiffLines(data?.diff), [data?.diff])
      const stat = React.useMemo(() => diffStat(lines), [lines])
      const shown = lines.length > MAX_RENDER_LINES ? lines.slice(0, MAX_RENDER_LINES) : lines
      const body =
        lines.length === 0
          ? h('div', { className: 'dshg-empty' }, data?.error ? data.error : t('diffEmpty'))
          : h(
              'div',
              { className: 'dshg-diff-body' },
              shown.map((line, index) =>
                h(
                  'div',
                  { key: index, className: `dshg-line${line.type === 'add' ? ' dshg-add' : line.type === 'del' ? ' dshg-del' : line.type === 'hunk' ? ' dshg-hunk' : line.type === 'meta' ? ' dshg-meta' : ''}` },
                  h('span', { className: 'dshg-ln' }, line.oldNo === '' ? '' : String(line.oldNo)),
                  h('span', { className: 'dshg-ln' }, line.newNo === '' ? '' : String(line.newNo)),
                  h('span', { className: 'dshg-lt' }, `${line.sign}${line.text}`),
                ),
              ),
              lines.length > shown.length ? h('div', { className: 'dshg-empty' }, `${t('diffTruncated')} (${lines.length})`) : null,
            )

      return h(
        'div',
        { className: 'dshg-diff' },
        h(
          'div',
          { className: 'dshg-diff-head' },
          h('span', { className: 'dshg-diff-path', title: data?.file }, data?.file ?? ''),
          stat.add > 0 ? h('span', { className: 'dshg-k-added' }, `+${stat.add}`) : null,
          stat.del > 0 ? h('span', { className: 'dshg-k-deleted' }, `-${stat.del}`) : null,
          h('button', { className: 'dshg-btn is-icon', type: 'button', onClick: onClose, title: t('closeDiff'), 'aria-label': t('closeDiff') }, '✕'),
        ),
        error !== null && error !== undefined ? h('div', { className: 'dshg-error' }, `${t('failed')}${error}`) : null,
        loading ? h('div', { className: 'dshg-empty' }, t('loading')) : body,
      )
    }

    /** 一行文件：名字 + 状态字母 + hover 动作。 */
    function FileRow({ file, staged, active, onOpen, onStage, onUnstage, onDiscard }) {
      const { dir, name } = splitPath(file.path)
      // 未跟踪文件的「丢弃」其实是删除：git 里没有它的任何备份，host 侧会走 clean -f。
      // 图标与文案都跟着改，否则用户以为只是还原，实际文件没了。
      const removes = file.kind === 'untracked'
      const actionLabel = removes ? t('deleteUntracked') : t('discard')
      return h(
        'div',
        {
          className: `dshg-file${active ? ' is-active' : ''}`,
          onClick: () => onOpen(file, staged),
          title: file.from === undefined ? file.path : `${file.from} → ${file.path}`,
          role: 'button',
          tabIndex: 0,
        },
        h('span', { className: `dshg-letter dshg-k-${file.kind}` }, statusLetter(file.kind)),
        h(
          'span',
          { className: 'dshg-file-name' },
          dir === '' ? name : h('span', { className: 'dshg-file-dir' }, dir),
          dir === '' ? null : name,
        ),
        h(
          'span',
          { className: 'dshg-file-actions', onClick: (event) => event.stopPropagation() },
          staged
            ? h('button', { className: 'dshg-btn is-icon', type: 'button', title: t('unstage'), 'aria-label': t('unstage'), onClick: () => onUnstage(file) }, '−')
            : h('button', { className: 'dshg-btn is-icon', type: 'button', title: t('stage'), 'aria-label': t('stage'), onClick: () => onStage(file) }, '+'),
          h('button', { className: 'dshg-btn is-icon', type: 'button', title: actionLabel, 'aria-label': actionLabel, onClick: () => onDiscard(file) }, removes ? '✕' : '↺'),
        ),
      )
    }

    /** 可折叠分组。 */
    function Section({ title, count, open, onToggle, children, actions }) {
      return h(
        'div',
        { className: 'dshg-section' },
        h(
          'div',
          { className: 'dshg-section-head', onClick: onToggle, role: 'button', tabIndex: 0 },
          h('span', { className: `dshg-caret${open ? ' is-open' : ''}` }, '▶'),
          h('span', { className: 'dshg-section-title' }, title),
          h('span', { className: 'dshg-count' }, String(count)),
          h('span', { className: 'dshg-spacer' }),
          actions === undefined ? null : h('span', { onClick: (event) => event.stopPropagation() }, actions),
        ),
        open ? children : null,
      )
    }

    /**
     * 提交列表里的一行：左边是泳道图的一格，右边是提交信息。
     *
     * 图用纯 div 画（竖线是 2px 宽的 span），不引 SVG：
     * 行高由内容决定、每行都要重画，div + flex 更简单，也不必算坐标。
     *
     * @param props.commit - 提交对象。
     * @param props.row - buildGraph 算出的这一行 { lane, lanes, parents }。
     * @param props.laneCount - 总泳道数，决定左侧留多宽。
     * @param props.isHead - 是不是当前 HEAD 指向的提交（主角要高亮）。
     * @param props.onOpen - 点开提交详情。
     */
    function CommitRow({ commit, row, laneCount, isHead, onOpen }) {
      const LANE_W = 12
      const lane = row === undefined ? 0 : row.lane
      const grid = row === undefined ? [] : row.lanes
      // 一行里可能有 1~3 段竖线：节点上方接着旧线，下方分给父提交。
      // 上方的线画成横跨整行；下方的线从节点那列画到各父提交所在列，形成分叉/汇流的斜感。
      const parentLanes = row === undefined ? [] : row.parents
      return h(
        'div',
        { className: 'dshg-commit', onClick: () => onOpen(commit), role: 'button', tabIndex: 0 },
        h(
          'div',
          { className: 'dshg-graph', style: { width: `${Math.max(laneCount, 1) * LANE_W + 4}px` } },
          // 上半段：节点之前的竖线（这一行网格里除了自己那列之外的线都穿行而过）。
          h(
            'div',
            { className: 'dshg-graph-half is-top' },
            grid.map((value, index) =>
              value === null || index === lane
                ? null
                : h('span', { key: `t${index}`, className: 'dshg-thread', style: { left: `${index * LANE_W + LANE_W / 2}px` } }),
            ),
          ),
          h('span', {
            className: `dshg-node${isHead ? ' is-head' : ''}`,
            style: { left: `${lane * LANE_W + LANE_W / 2}px` },
          }),
          // 下半段：节点之后分向各父提交的竖线。父多于一列时加一段横向连线表示汇流。
          h(
            'div',
            { className: 'dshg-graph-half is-bottom' },
            parentLanes.map((parentLane, index) =>
              h('span', {
                key: `b${index}`,
                className: `dshg-thread${index === 0 ? ' is-main' : ''}`,
                style: { left: `${parentLane * LANE_W + LANE_W / 2}px` },
              }),
            ),
            parentLanes.length > 1
              ? h('span', {
                  className: 'dshg-graph-join',
                  style: {
                    left: `${Math.min(...parentLanes) * LANE_W + LANE_W / 2}px`,
                    width: `${(Math.max(...parentLanes) - Math.min(...parentLanes)) * LANE_W}px`,
                  },
                })
              : null,
          ),
        ),
        h(
          'div',
          { className: 'dshg-commit-main' },
          h('div', { className: 'dshg-subject', title: commit.subject }, commit.subject === '' ? '(no subject)' : commit.subject),
          h(
            'div',
            { className: 'dshg-commit-meta' },
            h('span', { className: 'dshg-hash' }, commit.shortHash),
            h('span', null, commit.author),
            h('span', null, formatDate(commit.date)),
            ...(commit.refs ?? []).slice(0, 3).map((ref, index) =>
              h(
                'span',
                {
                  key: `${ref}-${index}`,
                  // 当前分支的标签要一眼认出来：HEAD 指向的这一行，它的分支名标签高亮，其余中性。
                  className: `dshg-ref${isHead && !ref.startsWith('origin/') ? ' is-head' : ''}`,
                },
                ref.replace(/^HEAD -> /, ''),
              ),
            ),
          ),
        ),
      )
    }

    /**
     * 主面板。
     *
     * 一个组件装下全部状态：这是右侧栏 tab 的常规形态（浏览器 tab 也是单组件 + store），
     * 拆太细反而要把十几个回调层层传下去。
     *
     * 关于拿「仓库路径」：宿主对 tab 主体派发的是**标准 props + 槽位注入**，
     * 并不存在 props.view 这种东西。会话工作目录必须按官方 files 面板同样的方式取——
     * `useSessions((sessions) => sessions.byId[sessionId]?.cwd)`，其中 sessionId 由宿主注入。
     * （早先误用 props.view.cwd，于是永远拿不到路径，面板一律显示「不是 Git 仓库」。）
     * @param props.sessionId - 宿主注入的当前会话 id。
     * @param props.useSessions - 宿主注入的会话快照选择器 hook。
     * @param props.useTabInfo - 宿主注入的 tab 读取 hook（拿到 tab.id 与 actions）。
     */
    function GitPanel(props) {
      const { sessionId, useSessions, useTabInfo, t: translate } = props
      // 宿主把 t 作为标准 prop 注入（已带命名空间）。模块级的 t 是给渲染树深处那些
      // 不接 props 的小组件与测试兜底用的，这里同步一次，保证两边查的是同一份字典。
      if (typeof translate === 'function') t = translate
      /** 会话工作目录，就是 git 仓库的候选路径。 */
      const cwd = typeof useSessions === 'function' ? useSessions((sessions) => sessions?.byId?.[sessionId]?.cwd) : undefined
      /** tab 句柄：用于把刷新绑到 tab 的刷新命令上。 */
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : undefined

      /** 仓库路径：优先用会话工作目录，其次用用户手填并记住的值。 */
      const [repoPath, setRepoPath] = React.useState(() => (typeof cwd === 'string' && cwd !== '' ? cwd : ''))
      const [pathDraft, setPathDraft] = React.useState(() => (typeof cwd === 'string' && cwd !== '' ? cwd : ''))
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [tab, setTab] = React.useState('changes')
      const [message, setMessage] = React.useState('')

      const [stagedOpen, setStagedOpen] = React.useState(true)
      const [changesOpen, setChangesOpen] = React.useState(true)

      /** 当前展开的差异：{file, staged, data, loading, error}。 */
      const [diff, setDiff] = React.useState(null)
      /** 提交详情视图：非 null 时历史页显示详情。 */
      const [commitDetail, setCommitDetail] = React.useState(null)

      const [log, setLog] = React.useState([])
      const [logMore, setLogMore] = React.useState(false)
      const [logLoading, setLogLoading] = React.useState(false)
      const [branches, setBranches] = React.useState({ locals: [], remotes: [] })
      /** 新建分支表单：null 表示收起，否则 {name, startPoint}。 */
      const [newBranch, setNewBranch] = React.useState(null)
      /** 合并策略：默认允许快进（更常见的期望），可切换为强制生成合并提交。 */
      const [mergeFastForward, setMergeFastForward] = React.useState(true)
      /**
       * 当前选中的贮藏 ref（stash@{n}）。
       *
       * 有意不默认选最新那条：恢复/删除都是「改工作区」的操作，默认值会让人
       * 点一下就动了 stash@{0}，而自己以为选的是别的。空串 = 还没选，此时所有
       * 贮藏操作按钮都禁用，逼用户显式选一次。
       */
      const [stashRef, setStashRef] = React.useState('')
      /**
       * 面板常驻容器。用于在「即将卸载当前焦点元素」时把焦点收回来，
       * 详见 releaseFocus() 的说明——不这么做会让整个应用的键盘输入失效。
       */
      const rootRef = React.useRef(null)
      /**
       * 记下「最后一次是本插件把焦点放到了哪个节点上」。
       *
       * 自愈 effect 靠它把范围收得极窄：只回收**我们自己放上去、随后又被卸载**的
       * 那个节点。用户主动点到别处（哪怕是点到面板外、或点到某个随后关闭的浮层）
       * 都不满足这个条件，因此绝不会被抢走焦点。
       */
      const placedFocusRef = React.useRef(null)

      /*
       * 焦点兜底。
       *
       * 这是本插件最容易造成全局故障的一处，机制如下：
       *   ① 写操作走 run()，它把 busy 置 true，于是面板内 21 个按钮同时被 disabled；
       *      浏览器会立刻 blur 掉那个「刚变成 disabled」、正持有焦点的按钮，焦点落到 body。
       *   ② 宿主的焦点保持逻辑（dsh-client-ui-sidebar-right 的 observeSidebarFocus）本可救场，
       *      但它只在两个条件下动作：元素被**移除**（MutationObserver 只看 childList），
       *      或 focusout 时焦点已交给别处（relatedTarget !== null）。
       *      而 disabled 只是改属性、元素并没有被移除，且 focusout 的 relatedTarget 是 null，
       *      于是宿主走了 `if (event.relatedTarget === null && focused?.element.isConnected)`
       *      这条分支——直接清空自己记录的焦点并断开观察。
       *      从此它没有任何可恢复的目标，焦点永久停在 body 上。
       *   ③ 用户表现就是「操作完打字进不了输入框，点别处也恢复不了」。
       *
       * releaseFocus 负责「动之前先挪走」，restoreFocus 负责「动完了再还回来」。
       * 两者都只在焦点确实属于面板时才插手，用户主动点到别处绝不干预。
       */

      /**
       * 判断一个节点是否真的还挂在当前文档里。
       *
       * 光看 `isConnected` 还不够：React 换根、宿主搬 pane 之后，旧节点可能
       * 被保留但已经不在 document 下。这里再沿 parent 链确认一次。
       * @param node - 待检查的元素。
       * @returns 节点可用（在其所属文档内）时为 true。
       */
      function isLiveNode(node) {
        if (node === null || node === undefined || node.isConnected !== true) return false
        const owner = node.ownerDocument ?? (typeof document === 'undefined' ? null : document)
        if (owner === null || owner.body === null || owner.body === undefined) return true
        return owner.body.contains(node)
      }

      /**
       * 把焦点放到当前的面板根容器上，并记下「是我们放的」。
       * @returns 是否真的放上去了。
       */
      function placeFocusOnRoot() {
        if (typeof document === 'undefined') return false
        const target = rootRef.current
        if (!isLiveNode(target)) return false
        // tabindex=-1：可编程聚焦，又不进 Tab 序列，不干扰键盘导航。
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
        target.focus({ preventScroll: true })
        if (document.activeElement !== target) return false
        placedFocusRef.current = target
        return true
      }

      /**
       * 记下「动作开始前持有焦点的那个元素」。
       *
       * 动作结束后用它做**次选**目标：面板外的输入框已经不在了时，就把焦点还给这个
       * 控件（点「应用贮藏」时那个按钮就是它）——看得见焦点在哪，而面板容器是个
       * 不可见 div，焦点落上去等于「不知道被聚焦到哪里了」。这个也没了才退到容器。
       */
      const focusReturnRef = React.useRef(null)

      /**
       * 记下「点面板之前，焦点在面板外的哪个元素上」。
       *
       * 这就是「操作完贮藏/丢弃回不到会话输入框」要用的东西：用户本来在输入框里打字，
       * 鼠标移到面板上点一个按钮，动作做完却把焦点留在了面板里——打字自然没了着落。
       * 所以动作结束后，只要焦点没有落在用户自己选的地方，就把它还给当初那个输入框。
       *
       * 记录时机必须是**指针按下**那一刻：浏览器把焦点交给被点的按钮是 mousedown 的
       * 默认行为，排在 pointerdown 之后，等点击回调里再读 activeElement 读到的已经是
       * 面板里的按钮了（`onPointerDownCapture` 恰好在这之前跑）。
       *
       * 点面板时焦点本来就在面板里 ⇒ 记 null（而不是保留上一个面板外的元素）：
       * 用户正打算在面板里连点几下，这时把焦点甩回输入框才是打扰。
       */
      const outsideFocusRef = React.useRef(null)

      /**
       * 指针按在面板上时，先看看焦点原本在哪。
       *
       * 不需要事件对象的字段：会触发它就说明「按下发生在面板内」，
       * 要看的是此刻 `document.activeElement` 在哪。
       */
      function rememberOutsideFocus() {
        if (typeof document === 'undefined') return
        const root = rootRef.current
        const active = document.activeElement
        if (active === null || active === document.body || !isLiveNode(active)) {
          outsideFocusRef.current = null
          return
        }
        outsideFocusRef.current = root !== null && root.contains(active) ? null : active
      }

      /**
       * 记下动作开始前焦点是否在面板内，用于事后判断要不要还焦点。
       * 焦点在面板内时顺手把那个元素记进 focusReturnRef。
       * @returns 动作开始时焦点是否在面板内。
       */
      const captureFocus = React.useCallback(() => {
        if (typeof document === 'undefined') return false
        const root = rootRef.current
        const active = document.activeElement
        if (root === null || active === null || active === document.body) return false
        if (!root.contains(active)) return false
        focusReturnRef.current = active
        return true
      }, [])

      /**
       * 把焦点还回去，按三级退让挑目标：
       *   ① 面板外原来那个元素（`outsideFocusRef`，通常就是会话输入框）；
       *   ② 动作前持有焦点的那个控件（`focusReturnRef`，面板内的按钮）；
       *   ③ 面板容器 —— 兜底，只为不让焦点掉到 `body`（那会让宿主再也恢复不了）。
       *
       * 只在焦点「归我们管」时才动手，两种情形都算：
       *   · 焦点已经落空（`body` / 无）：按钮被 `disabled` 或控件被卸载留下的；
       *   · 焦点正停在动作前那个控件上：那是点击带过去的，不是用户想去的地方。
       * 用户若自己把焦点放到了别处（比如点了会话输入框、或点了别的面板），
       * 这里什么都不做，绝不抢。
       *
       * 为什么要试两次：第一次在 microtask 里跑，很可能赶在 React 提交之前——那一刻
       * 被点过的按钮还带着 `disabled`，浏览器拒绝把焦点交给它。等这一帧过去
       * （`setTimeout 0`）再试一次，按钮已经重新可用。第一次允许「把焦点从那个控件上
       * 搬走」，因为那一瞬间用户不可能已经点了别处；第二次必须是严格模式，否则用户
       * 中途又点了同一个按钮（想再来一次）会被我们抢走。
       */
      const restoreFocus = React.useCallback(() => {
        if (typeof document === 'undefined') return
        /**
         * 尝试还焦点。
         * @param takeFromControl - 为 true 时，焦点停在动作前的控件上也照样搬走。
         */
        const attempt = (takeFromControl) => {
          if (typeof document === 'undefined') return
          const now = document.activeElement
          const parked = now === null || now === document.body
          const onControl = takeFromControl && now !== null && now === focusReturnRef.current
          if (!parked && !onControl) return
          for (const candidate of [outsideFocusRef.current, focusReturnRef.current]) {
            if (!isLiveNode(candidate)) continue
            if (candidate.disabled === true || typeof candidate.focus !== 'function') continue
            candidate.focus({ preventScroll: true })
            if (document.activeElement === candidate) {
              placedFocusRef.current = candidate
              return
            }
          }
          placeFocusOnRoot()
        }
        // 等 React 提交完 DOM 再读 activeElement，否则读到的还是旧值。
        queueMicrotask(() => attempt(true))
        setTimeout(() => attempt(false), 0)
      }, [])

      /**
       * 焦点自愈：收拾「本插件放上去、随后那个节点被卸载」的悬空焦点。
       *
       * 为什么必须有它——这是「应用贮藏后焦点不知道跑哪去了」的根因。
       *
       * `restoreFocus` 是在 `run()` 的 finally 里跑的，那个 microtask 很可能排在
       * React 提交**之前**：此刻 `rootRef.current` 还是上一轮的根节点 R0，而 R0
       * 在这一瞬间仍然 connected，于是 `placeFocusOnRoot()` 欣然成功。紧接着
       * `setStatus(...)` 那一轮提交把面板子树换成新的根节点 R1，**R0 被卸载**，
       * 可 `document.activeElement` 仍然指着 R0 —— 焦点于是卡在一个脱离文档的节点上。
       *
       * 宿主的 `observeSidebarFocus` 救不了这种形态：它捕获焦点时用
       * `closest('[data-dockkit-pane]')` 找所属 pane，对已卸载的 R0 找不到；
       * 它的 MutationObserver 也只会去 focus pane，不会修 activeElement。
       * 用户表现就是「焦点不知道被聚焦到哪里了，打字进不了输入框」。
       *
       * 与其跟 React 的调度时序赛跑，不如在「DOM 已经换完之后」统一收口：每次提交后
       * 检查一下——如果当前焦点正是**我们自己**刚放上去的那个节点、而它现在已经不在
       * 文档里，就把焦点挪到当前真正的根节点上。
       *
       * 三道闸门保证不越界：
       *   ① 没放过焦点（`placedFocusRef` 为空）就不管；
       *   ② 焦点不在我们放的那个节点上（用户自己点了别处）就不管；
       *   ③ 那个节点还活着就不管。
       */
      React.useEffect(() => {
        if (typeof document === 'undefined') return
        const placed = placedFocusRef.current
        if (placed === null) return
        if (document.activeElement !== placed) return
        if (isLiveNode(placed)) return
        // 我们放的节点已经被换掉了：把焦点交给当前真正活着的根节点。
        //
        // 成功时 placeFocusOnRoot 会把 placedFocusRef 更新成新的根节点，下一轮就不再
        // 匹配；万一这次没放上（ref 尚未就绪之类），标记保持原样，下一次提交还会再试——
        // 本 effect 不带依赖数组、每次提交后都跑，天然就是一个会收敛的重试。
        placeFocusOnRoot()
      })

      /**
       * 在「即将卸载当前焦点元素」的状态更新之前，把焦点主动交还给面板根节点。
       *
       * 与 run() 里的 capture/restore 互补：那条覆盖「按钮被 disabled」，
       * 这条覆盖「表单/下拉框整个被卸载」——卸载后再还焦点已经晚了，
       * 焦点会掉进面板这个 tabindex=-1 的容器里，宿主的恢复判断同样不成立。
       *
       * 与 restoreFocus 同理：只有当容器**确实还挂在文档里**时才把焦点交给它。
       * 否则宁可不搬——留在原处等 React 卸载时浏览器自己把焦点交给 body，
       * 也比塞进一个脱离文档的节点强。
       * @param nodeRef - 指向面板常驻容器的 ref。
       */
      function releaseFocus(nodeRef) {
        if (typeof document === 'undefined') return
        const active = document.activeElement
        const root = nodeRef?.current ?? null
        if (active === null || active === document.body) return
        if (root !== null && !root.contains(active)) return
        if (!isLiveNode(root)) return
        if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1')
        root.focus({ preventScroll: true })
        if (document.activeElement === root) placedFocusRef.current = root
      }

      // 会话工作目录晚于首次渲染就绪时同步过来（新会话/切工作区都会变）。
      React.useEffect(() => {
        if (typeof cwd === 'string' && cwd !== '' && repoPath === '') {
          setRepoPath(cwd)
          setPathDraft(cwd)
        }
      }, [cwd])

      /**
       * 刷新仓库状态。失败区分「不是仓库」与「真的报错」。
       * @param target - 要刷新的仓库路径，缺省用当前 repoPath。
       * @param options.keepError - 为 true 时不清理已有的错误提示。
       *   动作失败后补拉状态时会用到：那一句「改动可能已生效」正是要给人看的，
       *   若被这次刷新的 setError(null) 抹掉，用户就只看得到一闪而过的提示。
       * @returns 拿到的状态对象；请求失败或不是仓库时返回 null（调用方要靠它
       *   判断「这次失败到底改没改工作区」，所以必须把结果交出去）。
       */
      const refresh = React.useCallback(
        async (target, options) => {
          const path = target ?? repoPath
          if (path === '') return null
          const keepError = options?.keepError === true
          // 与 run() 同理：刷新按钮也会因为 busy 被 disabled，焦点必须先收回来。
          const hadFocus = captureFocus()
          setBusy(true)
          try {
            const payload = await api.status(path)
            if (payload?.error === 'not-a-repo') {
              setStatus(null)
              setError(null)
              setNotice('not-a-repo')
              return null
            }
            if (payload?.error) {
              setStatus(null)
              setError(payload.message ?? payload.error)
              return null
            }
            setStatus(payload)
            if (!keepError) setError(null)
            setNotice(null)
            return payload
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
            return null
          } finally {
            setBusy(false)
            if (hadFocus) restoreFocus()
          }
        },
        [repoPath, captureFocus, restoreFocus],
      )

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      // 把工具栏的「刷新」绑到 tab 自己的刷新命令上，和 files/浏览器面板一致。
      const tabActions = tabInfo?.tab?.actions
      const tabId = tabInfo?.tab?.id
      React.useEffect(() => {
        if (tabActions === undefined || typeof tabActions.bindCommands !== 'function') return undefined
        return tabActions.bindCommands({ refresh: () => void refresh() })
      }, [tabActions, tabId, refresh])

      const loadLog = React.useCallback(
        async (skip) => {
          if (repoPath === '') return
          setLogLoading(true)
          try {
            const payload = await api.log(repoPath, { skip: skip ?? 0, limit: LOG_PAGE })
            if (payload?.error) setError(payload.error)
            else {
              setLog((previous) => (skip === undefined || skip === 0 ? payload.commits : [...previous, ...payload.commits]))
              setLogMore(payload.hasMore === true)
            }
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setLogLoading(false)
          }
        },
        [repoPath],
      )

      const loadBranches = React.useCallback(async () => {
        if (repoPath === '') return
        try {
          const payload = await api.branches(repoPath)
          if (!payload?.error) setBranches({ locals: payload.locals ?? [], remotes: payload.remotes ?? [] })
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [repoPath])

      // 切到某个页签时才拉它需要的数据：历史/分支不必在打开面板时就查。
      React.useEffect(() => {
        if (status === null) return
        if (tab === 'history' && log.length === 0) void loadLog(0)
        if (tab === 'branches') void loadBranches()
      }, [tab, status, log.length, loadLog, loadBranches])

      // 成功提示自动消失，避免一直占着地方。
      React.useEffect(() => {
        if (notice === null || notice === 'not-a-repo') return undefined
        const timer = setTimeout(() => setNotice(null), 2600)
        return () => clearTimeout(timer)
      }, [notice])

      /**
       * 统一的写操作入口：跑完顺手刷新状态。
       * @param action - Host 的动作名。
       * @param payload - 动作参数。
       * @param successKey - 成功提示的文案键；不传就没有成功提示。
       * @param options.confirm - 需要确认时给出的问句。对话框必须**排在 captureFocus()
       *   之后**：原生确认框会把焦点交给系统（Chromium 里 activeElement 直接掉到 body），
       *   弹完再读 activeElement 就只读到 body，于是「动之前焦点在面板里」这个判断
       *   永远为假，焦点再也还不回来——这正是「应用贮藏（保留）之后打字进不了输入框」
       *   的原因。把弹窗收进这里，所有需要确认的动作都自动走同一条正确的顺序。
       */
      const run = React.useCallback(
        async (action, payload, successKey, options) => {
          // 必须在 setBusy(true) **之前**判断：一旦 busy 生效，正持有焦点的按钮
          // 立刻被 disabled，浏览器随即 blur 它，此刻再读 activeElement 已经晚了。
          const hadFocus = captureFocus()
          const question = options?.confirm
          if (question !== undefined && typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(question)) {
            // 取消也要收拾：弹窗已经把焦点挪出面板，不还回去就是「打字进不了输入框」。
            // restoreFocus 只在焦点确实空着时才动手，所以中间没弹窗的情况不会被它多事。
            if (hadFocus) restoreFocus()
            return null
          }
          setBusy(true)
          setError(null)
          try {
            const result = await api.action(repoPath, action, payload)
            if (result?.error === 'not-a-repo') {
              setNotice('not-a-repo')
              setStatus(null)
              return null
            }
            if (result?.ok === false) {
              const detail = describeFailure(result)
              // 报了失败不等于工作区没变：git 可能已经在写盘途中被超时打断
              // （改动落盘了、进程却非 0 退出），或者干脆是冲突——冲突时
              // `git stash apply` 退出码 1、stderr 为空、内容全写进 stdout，
              // 而文件已经带冲突标记落到工作区里了。这时若沿用旧快照，面板会一直
              // 显示操作前的状态——用户看到「明明应用成功了，界面却说干净」。
              // 所以失败也必须重新读一次真实状态；keepError 保证这条失败提示
              // 不会被这次刷新的 setError(null) 顺手抹掉。
              const fresh = await refresh(undefined, { keepError: true })
              // 顺手把「失败」说准：工作区里真有冲突文件，就别说成「什么都没发生」
              // （否则用户看到报错、又看到文件确实变了，只能自己猜哪句是真的）。
              const conflicted = (fresh?.files ?? []).filter((file) => file.kind === 'conflicted')
              setError(
                conflicted.length === 0
                  ? detail
                  : fmt('actionConflict', {
                      n: conflicted.length,
                      files: conflicted.slice(0, 3).map((file) => file.path).join(', '),
                    }),
              )
              return null
            }
            if (result?.status) setStatus(result.status)
            if (successKey !== undefined) setNotice(successKey)
            // 历史与分支在写操作后可能已经变了，标记成需要重取。
            if (action === 'commit' || action === 'commit-amend') setLog([])
            if (action.includes('branch') || action === 'checkout' || action === 'checkout-commit') void loadBranches()
            return result
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
            return null
          } finally {
            setBusy(false)
            // 只有「动之前在面板里、动完焦点丢了」才还焦点；用户自己点到别处就不碰。
            if (hadFocus) restoreFocus()
          }
        },
        [repoPath, loadBranches, captureFocus, restoreFocus, refresh],
      )

      const openDiff = React.useCallback(
        async (file, staged) => {
          setDiff({ file: file.path, staged, data: null, loading: true, error: null })
          try {
            const payload = await api.diff(repoPath, file.path, { staged })
            setDiff({ file: file.path, staged, data: payload, loading: false, error: payload?.error ?? null })
          } catch (cause) {
            setDiff({ file: file.path, staged, data: null, loading: false, error: cause instanceof Error ? cause.message : String(cause) })
          }
        },
        [repoPath],
      )

      const openCommit = React.useCallback(
        async (commit) => {
          setCommitDetail({ loading: true, commit: null, error: null })
          try {
            const payload = await api.commit(repoPath, commit.hash)
            if (payload?.error) setCommitDetail({ loading: false, commit: null, error: payload.message ?? payload.error })
            else setCommitDetail({ loading: false, commit: payload.commit, error: null })
          } catch (cause) {
            setCommitDetail({ loading: false, commit: null, error: cause instanceof Error ? cause.message : String(cause) })
          }
        },
        [repoPath],
      )

      const doCommit = React.useCallback(async () => {
        if (message.trim() === '') return
        const result = await run('commit', { message })
        if (result !== null) setMessage('')
      }, [message, run])

      const discard = React.useCallback(
        async (file) => {
          // 未跟踪文件的确认语必须说「删除」：那条路径确实是把文件从磁盘上抹掉，
          // 沿用「放弃修改」会让用户以为是可逆的还原。
          const key = file.kind === 'untracked' ? 'deleteUntrackedConfirm' : 'discardConfirm'
          // 确认框交给 run() 弹：它得排在「记下当前焦点」之后，见 run() 的说明。
          await run('discard', { files: [file.path] }, undefined, { confirm: fmt(key, { file: file.path }) })
        },
        [run],
      )

      const discardAll = React.useCallback(async () => {
        await run('discard-all', {}, 'discardAllOk', { confirm: t('discardAllConfirm') })
      }, [run])

      /** 取当前选中的贮藏条目；没选就返回 null（按钮此时也应该是禁用的）。 */
      const selectedStash = React.useMemo(
        () => (status?.stashes ?? []).find((item) => item.ref === stashRef) ?? null,
        [status, stashRef],
      )

      /**
       * 贮藏当前更改。
       *
       * 「贮藏更改」按钮只在 `unstaged.length > 0` 时渲染 —— 贮藏成功后工作区变干净，
       * 这个按钮连同它的焦点会一起被卸载。所以要先 releaseFocus，
       * 再把焦点交出去，否则焦点掉进面板容器，整个应用都打不了字。
       */
      const stashSave = React.useCallback(async () => {
        releaseFocus(rootRef)
        await run('stash-save', {}, null)
      }, [run])

      /**
       * 应用 / 恢复 / 删除选中的贮藏。
       *
       * 三种操作都可能改工作区或丢数据，都不做静默，一律先确认；
       * 确认语里带上 ref 与说明文字，让人看清动的到底是哪一条。
       * 确认框由 run() 弹：它必须先记下当前焦点，弹完再读就已经晚了（见 run() 的说明）。
       * @param kind - 'apply'（保留）| 'pop'（恢复并删除）| 'drop'（删除）。
       */
      const runStash = React.useCallback(
        async (kind) => {
          const target = selectedStash
          if (target === null) return
          const key = kind === 'apply' ? 'stashApplyConfirm' : kind === 'pop' ? 'stashPopConfirm' : 'stashDropConfirm'
          const values = { ref: target.ref, message: target.message === '' ? t('stashNoMessage') : target.message }
          const action = kind === 'apply' ? 'stash-apply' : kind === 'pop' ? 'stash-pop' : 'stash-drop'
          const okKey = kind === 'apply' ? 'stashApplyOk' : kind === 'pop' ? 'stashPopOk' : null
          const result = await run(action, { name: target.ref }, okKey, { confirm: fmt(key, values) })
          // 选中的那条没了（pop/drop）就清空选择，免得下拉框指着一个不存在的 ref。
          // 这一步会把下拉框的值重置，等于让「当前有焦点的元素」发生变更，
          // 所以先把焦点从面板内部挪到常驻容器上，别让它落进看不见的地方。
          if (result !== null && kind !== 'apply') {
            releaseFocus(rootRef)
            setStashRef('')
          }
        },
        [run, selectedStash],
      )

      /**
       * 新建分支：成功后收起表单并切回「更改」页。
       *
       * 收起表单 = 卸载那个 autoFocus 的输入框（或承载焦点的「创建」按钮），
       * 所以必须先 releaseFocus，否则焦点会掉进面板容器里，整个应用都打不了字。
       *
       * 名字在这里再 sanitize 一次：输入框的 onChange 已经做过，但这条路径也是唯一的落库口，
       * 兜一层才不会因为新增调用方（快捷键、历史补全）而漏掉转换。
       * @param rawName - 用户输入的新分支名。
       * @param startPoint - 起点分支；空串表示当前 HEAD。
       */
      const createBranch = React.useCallback(
        async (rawName, startPoint) => {
          const name = sanitizeBranchName(rawName).trim()
          if (name === '') return
          releaseFocus(rootRef)
          const result = await run('create-branch', { name, startPoint }, null)
          if (result === null) return
          setNewBranch(null)
          void loadBranches()
          setTab('changes')
        },
        [run, loadBranches],
      )

      // ---- 空状态：还不是仓库 ----
      if (repoPath === '' || status === null) {
        const isNotRepo = notice === 'not-a-repo' || repoPath !== ''
        return h(
          'div',
          { className: 'dshg-root' },
          h('style', { key: 'style' }, CSS),
          h(
            'div',
            { className: 'dshg-top' },
            h('span', { className: 'dshg-branch-btn' }, h('span', { className: 'dshg-branch-name' }, `${t('rootLabel')}：${repoPath === '' ? '—' : repoPath}`)),
            h('span', { className: 'dshg-spacer' }),
            h('button', { className: 'dshg-btn', type: 'button', onClick: () => void refresh(), disabled: busy || repoPath === '' }, t('refresh')),
          ),
          error !== null ? h('div', { className: 'dshg-error' }, `${t('failed')}${error}`) : null,
          h(
            'div',
            { className: 'dshg-center' },
            h('div', { className: 'dshg-center-title' }, busy && repoPath === '' ? t('loading') : t('notRepo')),
            h('div', { className: 'dshg-center-hint' }, isNotRepo ? t('notRepoHint') : t('notRepoHint')),
            h(
              'div',
              { className: 'dshg-inline-form', style: { width: '100%', maxWidth: '380px' } },
              h('input', {
                className: 'dshg-input',
                type: 'text',
                value: pathDraft,
                placeholder: t('repoPath'),
                'aria-label': t('repoPath'),
                onChange: (event) => setPathDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && pathDraft.trim() !== '') {
                    setRepoPath(pathDraft.trim())
                    void refresh(pathDraft.trim())
                  }
                },
              }),
              h(
                'button',
                {
                  className: 'dshg-btn',
                  type: 'button',
                  disabled: pathDraft.trim() === '',
                  onClick: () => {
                    setRepoPath(pathDraft.trim())
                    void refresh(pathDraft.trim())
                  },
                },
                t('open'),
              ),
            ),
            repoPath !== ''
              ? h('button', { className: 'dshg-btn', type: 'button', disabled: busy, onClick: () => void run('init', {}, null).then(() => refresh()) }, busy ? t('initing') : t('init'))
              : null,
          ),
        )
      }

      // ---- 主视图 ----
      const staged = status.staged ?? []
      const unstaged = status.unstaged ?? []
      const total = (status.files ?? []).length
      const upstream = status.upstream

      const topBar = h(
        'div',
        { className: 'dshg-top' },
        h(
          'button',
          {
            className: 'dshg-branch-btn',
            type: 'button',
            title: status.detached === true ? t('detached') : status.branch,
            onClick: () => {
              setTab('branches')
              void loadBranches()
            },
          },
          h('span', null, '⑂'),
          h('span', { className: 'dshg-branch-name' }, status.detached === true ? t('detached') : status.branch),
          upstream === null
            ? null
            : h(
                'span',
                { className: 'dshg-sync' },
                upstream.ahead > 0 ? `↑${upstream.ahead}` : null,
                upstream.behind > 0 ? `↓${upstream.behind}` : null,
              ),
        ),
        h('span', { className: 'dshg-spacer' }),
        h('button', { className: 'dshg-btn', type: 'button', disabled: busy, onClick: () => void run('fetch', {}, 'fetchOk') }, t('fetch')),
        h('button', { className: 'dshg-btn', type: 'button', disabled: busy, onClick: () => void run('pull', {}, 'pullOk') }, t('pull')),
        upstream === null
          ? h('button', { className: 'dshg-btn', type: 'button', disabled: busy, onClick: () => void run('push-upstream', {}, 'pushOk') }, t('publish'))
          : h('button', { className: 'dshg-btn', type: 'button', disabled: busy, onClick: () => void run('push', {}, 'pushOk') }, t('push')),
        h('button', { className: 'dshg-btn is-icon', type: 'button', disabled: busy, title: t('refresh'), 'aria-label': t('refresh'), onClick: () => void refresh() }, '⟳'),
      )

      const tabsBar = h(
        'div',
        { className: 'dshg-tabs' },
        [
          { id: 'changes', label: t('changes'), count: total },
          { id: 'history', label: t('history'), count: undefined },
          { id: 'branches', label: t('branches'), count: branches.locals.length },
        ].map((entry) =>
          h(
            'button',
            { key: entry.id, type: 'button', className: `dshg-tab${tab === entry.id ? ' is-on' : ''}`, onClick: () => setTab(entry.id) },
            entry.label,
            entry.count === undefined || entry.count === 0 ? null : h('span', { className: 'dshg-count' }, String(entry.count)),
          ),
        ),
      )

      const feedback =
        error !== null
          ? h('div', { className: 'dshg-error' }, `${t('failed')}${error}`)
          : notice !== null && notice !== 'not-a-repo'
            ? h('div', { className: 'dshg-ok' }, t(notice))
            : null

      // 合并进行中：冲突解决期间用户最需要知道「我现在处于合并状态」以及怎么退出去。
      const mergeBanner =
        status.merging === true
          ? h(
              'div',
              { className: 'dshg-error', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('span', null, `${t('merging')} — ${t('mergeConflict')}`),
              h('span', { className: 'dshg-spacer' }),
              h('button', { className: 'dshg-btn', type: 'button', disabled: busy, onClick: () => void run('merge-abort', {}, null) }, t('mergeAbort')),
            )
          : null

      /**
       * 贮藏区：下拉选择 + 应用/恢复/删除。
       *
       * 放在「更改」区块里（而不是提交框下面）：应用贮藏产出的就是未暂存的改动，
       * 控件与它影响的那份列表放在一起更直观。
       *
       * 因此这里绝不能挂在 `unstaged.length > 0` 上——工作区干净时恰恰最需要它
       * （先把贮藏取出来才有东西可看），那种情况下区块也会为它保留一个位置。
       */
      const stashArea =
        status.stashes !== undefined && status.stashes.length > 0
          ? h(
              'div',
              { className: 'dshg-stash' },
              h(
                'div',
                { className: 'dshg-stash-row' },
                h('span', { className: 'dshg-stash-title' }, `${t('stash')}：${status.stashes.length}`),
                h(
                  'select',
                  {
                    className: 'dshg-input dshg-stash-select',
                    value: stashRef,
                    'aria-label': t('stashPick'),
                    onChange: (event) => setStashRef(event.target.value),
                  },
                  // 第一项是占位：不预选最新那条，逼用户显式选一次。
                  h('option', { value: '' }, `— ${t('stashPick')} —`),
                  status.stashes.map((item) =>
                    h(
                      'option',
                      { key: item.ref, value: item.ref, title: item.message },
                      `${item.ref}${item.message === '' ? '' : ` · ${item.message}`}`,
                    ),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'dshg-stash-actions' },
                // 应用（保留）排在前面并做主按钮：它不动贮藏列表，是更安全的默认选择。
                h(
                  'button',
                  { className: 'dshg-btn is-primary', type: 'button', disabled: busy || selectedStash === null, onClick: () => void runStash('apply') },
                  t('stashApply'),
                ),
                h(
                  'button',
                  { className: 'dshg-btn', type: 'button', disabled: busy || selectedStash === null, onClick: () => void runStash('pop') },
                  t('stashPop'),
                ),
                h('span', { className: 'dshg-spacer' }),
                h(
                  'button',
                  { className: 'dshg-btn is-icon is-danger', type: 'button', disabled: busy || selectedStash === null, title: t('stashDrop'), 'aria-label': t('stashDrop'), onClick: () => void runStash('drop') },
                  '✕',
                ),
              ),
            )
          : null

      /** 变更页：提交框 + 两个分组 + 差异视图。 */
      const changesTab = h(
        React.Fragment,
        { key: 'changes' },
        mergeBanner,
        h(
          'div',
          { className: 'dshg-commit-box' },
          h('textarea', {
            className: 'dshg-textarea',
            value: message,
            placeholder: staged.length === 0 ? t('noStaged') : t('commitMessage'),
            'aria-label': t('commitMessage'),
            onChange: (event) => setMessage(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void doCommit()
              }
            },
          }),
          h(
            'div',
            { className: 'dshg-commit-actions' },
            h(
              'button',
              { className: 'dshg-btn is-primary', type: 'button', disabled: busy || staged.length === 0 || message.trim() === '', onClick: () => void doCommit() },
              busy ? t('committing') : t('commit'),
            ),
            h('button', { className: 'dshg-btn', type: 'button', disabled: busy || message.trim() === '', onClick: () => void run('commit-amend', { message }) }, t('commitAmend')),
            h('span', { className: 'dshg-spacer' }),
            unstaged.length > 0
              ? h('button', { className: 'dshg-btn', type: 'button', disabled: busy, onClick: () => void stashSave() }, t('stashSave'))
              : null,
          ),
        ),
        diff === null ? null : h(DiffView, { data: diff.data, loading: diff.loading, error: diff.error, onClose: () => setDiff(null) }),
        total === 0 && stashArea === null
          ? h('div', { className: 'dshg-empty' }, `${t('clean')} — ${t('cleanHint')}`)
          : h(
              React.Fragment,
              null,
              h(
                Section,
                {
                  title: t('stagedChanges'),
                  count: staged.length,
                  open: stagedOpen,
                  onToggle: () => setStagedOpen((value) => !value),
                  actions:
                    staged.length > 0
                      ? h('button', { className: 'dshg-btn is-icon', type: 'button', disabled: busy, title: t('unstageAll'), 'aria-label': t('unstageAll'), onClick: () => void run('unstage-all', {}, null) }, '−')
                      : null,
                },
                staged.map((file) =>
                  h(FileRow, {
                    key: `s-${file.path}`,
                    file,
                    staged: true,
                    active: diff !== null && diff.file === file.path && diff.staged === true,
                    onOpen: openDiff,
                    onStage: () => {},
                    onUnstage: (target) => void run('unstage', { files: [target.path] }, null),
                    onDiscard: discard,
                  }),
                ),
              ),
              h(
                Section,
                {
                  title: t('changes'),
                  count: unstaged.length,
                  open: changesOpen,
                  onToggle: () => setChangesOpen((value) => !value),
                  actions:
                    unstaged.length > 0
                      ? [
                          h('button', { key: 'discard-all', className: 'dshg-btn is-icon is-danger', type: 'button', disabled: busy, title: t('discardAll'), 'aria-label': t('discardAll'), onClick: () => void discardAll() }, '⌫'),
                          h('button', { key: 'stage-all', className: 'dshg-btn is-icon', type: 'button', disabled: busy, title: t('stageAll'), 'aria-label': t('stageAll'), onClick: () => void run('stage-all', {}, null) }, '+'),
                        ]
                      : null,
                },
                // 贮藏区放在「更改」区块里：应用贮藏产出的正是未暂存的改动，
                // 把它和它会影响的那份列表放在一起，比塞在提交框下面更符合直觉。
                stashArea,
                unstaged.map((file) =>
                  h(FileRow, {
                    key: `u-${file.path}`,
                    file,
                    staged: false,
                    active: diff !== null && diff.file === file.path && diff.staged === false,
                    onOpen: openDiff,
                    onStage: (target) => void run('stage', { files: [target.path] }, null),
                    onUnstage: () => {},
                    onDiscard: discard,
                  }),
                ),
              ),
            ),
      )

      /** 历史页：提交列表或提交详情。 */
      const historyTab =
        commitDetail === null
          ? h(
              React.Fragment,
              { key: 'history' },
              ...(() => {
                if (log.length === 0) return [logLoading ? h('div', { key: 'loading', className: 'dshg-empty' }, t('loading')) : h('div', { key: 'empty', className: 'dshg-empty' }, t('noCommits'))]
                const graph = buildGraph(log)
                const nodes = log.map((commit, index) =>
                  h(CommitRow, {
                    key: commit.hash,
                    commit,
                    row: graph.rows[index],
                    laneCount: graph.laneCount,
                    // 当前分支就藏在 refs 里（`HEAD -> main`）；游离 HEAD 时没有这一项，
                    // 那就退而认 HEAD 自己所在的那一行。
                    isHead: (commit.refs ?? []).some((ref) => ref.startsWith('HEAD')),
                    onOpen: openCommit,
                  }),
                )
                // 分页会让图在页尾断开：明确提示，免得用户以为图就长这样。
                if (graph.truncated) nodes.push(h('div', { key: 'truncated', className: 'dshg-graph-note' }, t('graphTruncated')))
                return nodes
              })(),
              logLoading && log.length > 0 ? h('div', { className: 'dshg-empty' }, t('loading')) : null,
              logMore && !logLoading
                ? h('div', { className: 'dshg-inline-form' }, h('button', { className: 'dshg-btn', type: 'button', onClick: () => void loadLog(log.length) }, t('loadMore')))
                : null,
            )
          : h(
              React.Fragment,
              { key: 'detail' },
              h(
                'div',
                { className: 'dshg-diff-head' },
                h('button', { className: 'dshg-btn', type: 'button', onClick: () => setCommitDetail(null) }, `← ${t('back')}`),
                h('span', { className: 'dshg-spacer' }),
                h('span', { className: 'dshg-hash' }, commitDetail.commit?.shortHash ?? ''),
              ),
              commitDetail.loading
                ? h('div', { className: 'dshg-empty' }, t('loading'))
                : commitDetail.error !== null && commitDetail.error !== undefined
                  ? h('div', { className: 'dshg-error' }, `${t('failed')}${commitDetail.error}`)
                  : h(
                      React.Fragment,
                      null,
                      h(
                        'div',
                        { style: { padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
                        h('div', { style: { fontSize: '13px', fontWeight: 600, wordBreak: 'break-word' } }, commitDetail.commit.subject),
                        commitDetail.commit.body !== ''
                          ? h('pre', { style: { margin: '6px 0 0', fontSize: '11.5px', whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-secondary)' } }, commitDetail.commit.body)
                          : null,
                        h(
                          'div',
                          { className: 'dshg-commit-meta', style: { marginTop: '6px' } },
                          h('span', { className: 'dshg-hash' }, commitDetail.commit.hash),
                          h('span', null, `${t('by')} ${commitDetail.commit.author}`),
                          h('span', null, formatDate(commitDetail.commit.date)),
                          h('span', null, fmt('filesChanged', { n: (commitDetail.commit.files ?? []).length })),
                        ),
                      ),
                      h('div', { className: 'dshg-section-head' }, h('span', { className: 'dshg-section-title' }, t('commitFiles'))),
                      ...(commitDetail.commit.files ?? []).map((file, index) =>
                        h(
                          'div',
                          {
                            key: `${file.path}-${index}`,
                            className: 'dshg-file',
                            onClick: () => openDiff(file, false),
                            role: 'button',
                            tabIndex: 0,
                          },
                          h('span', { className: 'dshg-letter dshg-k-modified' }, file.status),
                          h('span', { className: 'dshg-file-name' }, file.path),
                        ),
                      ),
                    ),
            )

      /**
       * 分支页：新建（可选起点）+ 本地/远程列表（切换、合并、删除）。
       *
       * 「起点」下拉里同时列出本地与远程分支，外加当前 HEAD：
       * 建分支最常用的两种意图就是「从当前继续」和「从某个远端分支拉一条本地线」，
       * 让它们出现在同一个下拉框里，比先切分支再建少一步。
       */
      const sourceOptions = [
        { value: '', label: `${t('startPointHead')} (${status.branch})` },
        ...branches.locals.filter((branch) => branch.current !== true).map((branch) => ({ value: branch.name, label: branch.name })),
        ...branches.remotes.map((branch) => ({ value: branch.name, label: branch.name })),
      ]
      const branchesTab = h(
        React.Fragment,
        { key: 'branches' },
        newBranch === null
          ? h(
              'div',
              { className: 'dshg-inline-form' },
              h('button', { className: 'dshg-btn', type: 'button', onClick: () => setNewBranch({ name: '', startPoint: '' }) }, `+ ${t('createBranch')}`),
              h('span', { className: 'dshg-spacer' }),
              // 合并策略：默认允许快进。强制合并提交会多出一个 merge commit，
              // 团队要求保留合并记录时才需要，所以做成显式开关而不是默认行为。
              h(
                'button',
                {
                  className: `dshg-btn${mergeFastForward ? ' is-on' : ''}`,
                  type: 'button',
                  title: mergeFastForward ? t('mergeFastForward') : t('mergeNoFf'),
                  'aria-label': mergeFastForward ? t('mergeFastForward') : t('mergeNoFf'),
                  onClick: () => setMergeFastForward((value) => !value),
                },
                mergeFastForward ? t('mergeFastForward') : t('mergeNoFf'),
              ),
            )
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'dshg-inline-form' },
                h('input', {
                  className: 'dshg-input',
                  type: 'text',
                  value: newBranch.name,
                  placeholder: t('newBranchPlaceholder'),
                  'aria-label': t('newBranchPlaceholder'),
                  autoFocus: true,
                  onChange: (event) => setNewBranch({ ...newBranch, name: sanitizeBranchName(event.target.value) }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && newBranch.name.trim() !== '') {
                      void createBranch(newBranch.name.trim(), newBranch.startPoint)
                    }
                    if (event.key === 'Escape') {
                      releaseFocus(rootRef)
                      setNewBranch(null)
                    }
                  },
                }),
                h(
                  'button',
                  {
                    className: 'dshg-btn',
                    type: 'button',
                    disabled: newBranch.name.trim() === '' || busy,
                    onClick: () => void createBranch(newBranch.name.trim(), newBranch.startPoint),
                  },
                  t('create'),
                ),
                h(
                  'button',
                  {
                    className: 'dshg-btn',
                    type: 'button',
                    onClick: () => {
                      // 取消同样会卸载输入框，焦点先还回去。
                      releaseFocus(rootRef)
                      setNewBranch(null)
                    },
                  },
                  t('cancel'),
                ),
              ),
              h(
                'div',
                { className: 'dshg-inline-form' },
                h('span', { className: 'dshg-section-title' }, t('startPoint')),
                h(
                  'select',
                  {
                    className: 'dshg-input',
                    value: newBranch.startPoint,
                    'aria-label': t('startPoint'),
                    onChange: (event) => setNewBranch({ ...newBranch, startPoint: event.target.value }),
                  },
                  // 远程分支可能很多，按 origin/ 之类的名字排一下，找起来更快。
                  sourceOptions
                    .slice()
                    .sort((left, right) => (left.value === '' ? -1 : right.value === '' ? 1 : left.value.localeCompare(right.value)))
                    .map((option) => h('option', { key: `src-${option.value}`, value: option.value }, option.label)),
                ),
              ),
            ),
        h('div', { className: 'dshg-section-head' }, h('span', { className: 'dshg-section-title' }, t('localBranches'))),
        branches.locals.length === 0
          ? h('div', { className: 'dshg-empty' }, t('noBranches'))
          : branches.locals.map((branch) =>
              h(
                'div',
                { key: branch.name, className: `dshg-branch${branch.current ? ' is-current' : ''}` },
                h('span', { className: 'dshg-caret' }, branch.current ? '●' : ' '),
                h(
                  'span',
                  { className: 'dshg-branch-name', title: branch.subject === undefined ? branch.name : `${branch.name} — ${branch.subject}` },
                  branch.name,
                  branch.upstream === null || branch.upstream === undefined ? null : h('span', { className: 'dshg-file-dir' }, ` → ${branch.upstream}`),
                ),
                h(
                  'span',
                  { className: 'dshg-branch-actions' },
                  branch.current
                    ? null
                    : h(
                        'button',
                        {
                          className: 'dshg-btn is-icon',
                          type: 'button',
                          disabled: busy,
                          title: `${t('merge')} ${branch.name} → ${status.branch}`,
                          'aria-label': `${t('merge')} ${branch.name}`,
                          onClick: () => void run('merge', { name: branch.name, ffOnly: mergeFastForward }, null).then(() => setTab('changes')),
                        },
                        '⇥',
                      ),
                  branch.current
                    ? null
                    : h('button', { className: 'dshg-btn is-icon', type: 'button', disabled: busy, title: t('checkout'), 'aria-label': t('checkout'), onClick: () => void run('checkout', { name: branch.name }, null).then(() => setTab('changes')) }, '⑂'),
                  branch.current
                    ? null
                    : h(
                        'button',
                        {
                          className: 'dshg-btn is-icon',
                          type: 'button',
                          disabled: busy,
                          title: t('delete'),
                          'aria-label': t('delete'),
                          onClick: () => {
                            // 确认框交给 run() 弹（必须先记下当前焦点，见 run() 的说明）。
                            void run('delete-branch', { name: branch.name }, null, { confirm: fmt('deleteBranchConfirm', { name: branch.name }) }).then(() => loadBranches())
                          },
                        },
                        '✕',
                      ),
                ),
              ),
            ),
        branches.remotes.length === 0
          ? null
          : h(
              React.Fragment,
              null,
              h('div', { className: 'dshg-section-head' }, h('span', { className: 'dshg-section-title' }, t('remoteBranches'))),
              branches.remotes.slice(0, 80).map((branch) =>
                h(
                  'div',
                  { key: branch.name, className: 'dshg-branch' },
                  h('span', { className: 'dshg-caret' }, ' '),
                  h('span', { className: 'dshg-branch-name', title: branch.name }, branch.name),
                  h(
                    'span',
                    { className: 'dshg-branch-actions' },
                    h(
                      'button',
                      {
                        className: 'dshg-btn is-icon',
                        type: 'button',
                        disabled: busy,
                        title: t('checkout'),
                        'aria-label': t('checkout'),
                        onClick: () => void run('checkout-commit', { name: branch.name }, null).then(() => setTab('changes')),
                      },
                      '⑂',
                    ),
                  ),
                ),
              ),
            ),
      )

      return h(
        'div',
        { className: 'dshg-root', ref: rootRef, onPointerDownCapture: rememberOutsideFocus },
        h('style', { key: 'style' }, CSS),
        topBar,
        tabsBar,
        feedback,
        h('div', { className: 'dshg-scroll' }, tab === 'changes' ? changesTab : tab === 'history' ? historyTab : branchesTab),
      )
    }

    /**
     * tab 的标题。
     *
     * 不给 tab 注册标题槽位时，chip 显示的是注册表在打开那一刻记下的静态名字；
     * 这里显式注册一个，让标题跟随语言切换。分支名不放在标题里——
     * 标题是「这个 tab 是什么」，分支是面板里一眼能看到的状态，塞进来只会让 chip 过长。
     * @param props.t - 宿主注入的翻译函数。
     */
    function GitTitle(props) {
      const translate = props?.t
      const label = typeof translate === 'function' ? translate('tabTitle') : t('tabTitle')
      return h('span', { className: 'dshg-title' }, label)
    }

    /**
     * tab 类型定义。
     *
     * `multiple: true`：一个会话可以同时开多个 Git tab（比如盯两个仓库）。
     * `guide` 决定它在右侧栏「+」卡片列表里的位置——order 40 紧跟在浏览器（30）之后。
     * `title` 是 tab 未自定义标题时的名字。
     */
    function gitDefinition() {
      return {
        id: GIT_ID,
        kind: GIT_KIND,
        multiple: true,
        priority: 'extension',
        title: () => t('type.label'),
        guide: [
          {
            id: 'open',
            order: 40,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: GitGuideIcon,
          },
        ],
      }
    }

    /** guide 卡片上的图标：四个提交点连成一条线，和 icon.svg 同构。 */
    function GitGuideIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 28
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 64 64', role: 'img', 'aria-label': 'Git' },
        h(
          'g',
          { fill: 'none', stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' },
          h('path', { d: 'M22 16v22' }),
          h('path', { d: 'M42 22v6' }),
          h('path', { d: 'M22 42c0 6 6 8 12 8h8' }),
        ),
        h('circle', { cx: 22, cy: 12, r: 7, fill: 'currentColor' }),
        h('circle', { cx: 42, cy: 17, r: 7, fill: 'currentColor' }),
        h('circle', { cx: 22, cy: 47, r: 7, fill: 'currentColor' }),
        h('circle', { cx: 47, cy: 51, r: 7, fill: 'currentColor' }),
      )
    }

    function apply(ctx) {
      t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'git: dictionaries')

      // tab 类型：让右侧栏认识 kind='git'，并把入口放进 guide 列表。
      ctx.effect(() => ctx.sidebarRightTabs.register(gitDefinition()), 'git: tab type')

      // tab 主体：派发到 GitPanel，拿到会话视图（cwd / setTitle）。
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: GIT_ID, locale: NS }, GitPanel),
          ),
        'git: tab body',
      )

      // tab 标题：与主体同样的 key 派发。
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: GIT_ID, locale: NS }, GitTitle),
          ),
        'git: tab title',
      )
    }

    return { inject: ['slots', 'locale', 'sidebarRightTabs'], apply, __test: { parseDiffLines, diffStat, splitPath, statusLetter } }
  },
})
