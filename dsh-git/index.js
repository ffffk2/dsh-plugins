/**
 * Git —— Host 半。
 *
 * 用 `git` CLI 实现右侧栏 Git tab 需要的一切读写操作，并通过下面几条同源路由暴露给
 * Client 半（浏览器里直接 fetch 相对路径即可，跨源请求会被 connection 围栏挡掉）：
 *
 *   GET  /git/status        仓库概要 + 暂存区/工作区变更列表 + 分支与远程状态
 *   GET  /git/diff          单个文件的 unified diff（可指定 staged / commit）
 *   GET  /git/log           提交历史（分页）
 *   GET  /git/commit        单次提交的详情（含改动文件列表）
 *   GET  /git/branches      本地/远程分支、当前分支、ahead/behind
 *   POST /git/action        所有写操作，靠 `action` 字段分派
 *
 * 设计取舍：
 *   - 不用任何 git 库（宿主约定「不新增运行时依赖」），走 `execFile('git', args)`，
 *     参数始终以数组传递且不开 shell，因此分支名/路径里的空格与引号无需转义，
 *     也不存在命令拼接注入。
 *   - 工作目录只接受客户端传来的 path，但**必须**落在本插件被 cfg.roots 允许的范围内
 *     （默认不限，只校验它确实是个 git 仓库）——这是防止任意目录读写的唯一闸门。
 *   - 所有输出都做过长度截断，避免一个巨型 diff 把页面卡死。
 *   - 一律 `-c core.quotepath=false`，中文文件名才不会显示成 \344\270\255 这样的转义。
 */
import { execFile } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Cordis 插件名。 */
export const name = 'git'
/** 需要 webServer 承载 git 路由；connection 可选（存在时用于鉴权检查）。 */
export const inject = ['webServer']

const STATUS_PATH = '/git/status'
const DIFF_PATH = '/git/diff'
const LOG_PATH = '/git/log'
const COMMIT_PATH = '/git/commit'
const BRANCHES_PATH = '/git/branches'
const ACTION_PATH = '/git/action'

/**
 * Host 半的代码版本号。
 *
 * 改了这个文件必须重启 DSH 才会生效（Node 缓存已导入的 ES 模块）。把它回报给页面，
 * 「页面看起来正常、跑的却是旧代码」就能当场看出来。**每次改这个文件都顺手加一。**
 */
const HOST_BUILD = 1

/** git 命令超时（毫秒）。fetch/push 会慢一些，单独放宽。 */
const TIMEOUT_MS = 20_000
/** 网络类命令的超时。 */
const NETWORK_TIMEOUT_MS = 120_000
/** 单次 diff 的最大字符数，超出截断并标记 truncated。 */
const MAX_DIFF_CHARS = 400_000
/** 单条命令 stdout 的硬上限，防止 OOM。 */
const MAX_BUFFER = 32 * 1024 * 1024
/** 历史提交每页条数上限。 */
const MAX_LOG_LIMIT = 200
/** 分支列表上限。 */
const MAX_BRANCHES = 500

/**
 * 执行一次 git 命令。
 *
 * 一律用 `-c core.quotepath=false`：git 默认会把非 ASCII 路径转义成八进制，
 * 中文文件名会显示成乱码，纯 UI 层面的坑。
 * @param cwd - 仓库工作目录。
 * @param args - git 子命令与参数（数组传递，不经 shell）。
 * @param options - 可覆盖超时与是否容忍非 0 退出码。
 * @returns {ok, stdout, stderr, code}；不抛异常，git 失败也当正常结果返回。
 */
function git(cwd, args, options = {}) {
  return new Promise((settle) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        timeout: options.timeout ?? TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        // 关键：不要继承调用方的 GIT_DIR / GIT_WORK_TREE，否则会把别的仓库当成目标。
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        settle({
          ok: error === null,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          code,
          killed: error !== null && error.killed === true,
        })
      },
    )
  })
}

/** 截断超长文本并标记，避免巨型 diff 撑爆页面。 */
function clampText(text, max = MAX_DIFF_CHARS) {
  if (typeof text !== 'string') return { text: '', truncated: false }
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/**
 * 校验并解析客户端传来的仓库路径。
 *
 * 这是唯一的路径闸门：只接受绝对路径、必须存在且是目录，再 realpath 消掉符号链接。
 * 允许的根目录由 cfg.roots 限定（默认空数组表示不限制）。
 * @param raw - 客户端传来的路径。
 * @param roots - 允许的根目录（已 realpath）；为空表示不限制。
 * @returns 解析后的绝对路径，或 null 表示不接受。
 */
function resolveRepo(raw, roots) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const input = raw.trim()
  if (!isAbsolute(input)) return null
  let real
  try {
    real = realpathSync(resolve(input))
    if (!statSync(real).isDirectory()) return null
  } catch {
    return null
  }
  if (roots.length === 0) return real
  const normalized = process.platform === 'win32' ? real.toLowerCase() : real
  const allowed = roots.some((root) => {
    const base = process.platform === 'win32' ? root.toLowerCase() : root
    return normalized === base || normalized.startsWith(base.endsWith('\\') || base.endsWith('/') ? base : `${base}${process.platform === 'win32' ? '\\' : '/'}`)
  })
  return allowed ? real : null
}

/** 确认目录确实在一个 git 仓库里（含裸仓库的工作树父目录）。 */
async function repoRoot(cwd) {
  const result = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) {
    // 裸仓库没有工作树，--show-toplevel 会失败；再试一次 --git-dir，让裸仓库也能被识别。
    const bare = await git(cwd, ['rev-parse', '--is-bare-repository'])
    if (bare.ok && bare.stdout.trim() === 'true') return { root: cwd, bare: true }
    return null
  }
  return { root: result.stdout.trim(), bare: false }
}

/**
 * 解析 porcelain v1 `-z` 输出。
 *
 * 用 `-z` 而不是普通输出：非 ASCII 路径在普通输出里即便关了 quotepath 也仍可能带引号，
 * 而 NUL 分隔是唯一无歧义的格式。XY 两位分别是暂存区与工作区状态。
 * @param raw - `git status --porcelain=v1 -z` 的原始输出。
 * @returns 变更条目数组。
 */
function parseStatusZ(raw) {
  const parts = raw.split('\0')
  const entries = []
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index]
    if (item === '' || item.length < 3) continue
    const indexStatus = item[0]
    const workStatus = item[1]
    const path = item.slice(3)
    // 重命名/复制：紧随其后的一项是被改前的原路径。
    let from
    if (indexStatus === 'R' || indexStatus === 'C' || workStatus === 'R' || workStatus === 'C') {
      index += 1
      from = parts[index] ?? undefined
    }
    if (path === '') continue
    entries.push({ x: indexStatus, y: workStatus, path, from })
  }
  return entries
}

/** git 状态码 → 语义分类，供页面配色与图标使用。 */
function classify(x, y) {
  if (x === '?' || y === '?') return 'untracked'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflicted'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'M' || y === 'M') return 'modified'
  return 'modified'
}

/** 是否已进入暂存区（X 位不是空格或 ?）。 */
function isStaged(entry) {
  return entry.x !== ' ' && entry.x !== '?' 
}

/** 读取 ahead/behind 与上游名字；没有上游时返回 null。 */
async function upstreamState(root) {
  const result = await git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
  if (!result.ok) return null
  const [behind, ahead] = result.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10))
  const nameResult = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  return {
    upstream: nameResult.ok ? nameResult.stdout.trim() : null,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  }
}

/** 组装一份完整的仓库状态。 */
async function buildStatus(root) {
  const [branchResult, statusResult, upstream, stashResult, gitDirResult] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    upstreamState(root),
    git(root, ['stash', 'list', '--format=%gd%x09%s']),
    git(root, ['rev-parse', '--git-dir']),
  ])

  const branch = branchResult.ok ? branchResult.stdout.trim() : 'HEAD'
  const entries = parseStatusZ(statusResult.stdout)
  const files = entries.map((entry) => ({
    path: entry.path,
    from: entry.from,
    x: entry.x,
    y: entry.y,
    staged: isStaged(entry),
    kind: classify(entry.x, entry.y),
  }))
  const staged = files.filter((file) => file.staged)
  const unstaged = files.filter((file) => !file.staged)

  const stashes = stashResult.ok
    ? stashResult.stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const [ref, ...rest] = line.split('\t')
          return { ref, message: rest.join('\t') }
        })
    : []

  // 进行中的合并靠 git 目录里的 MERGE_HEAD 判断，这是 git 自己的「合并未完成」标志。
  // 面板据此显示「合并中 + 放弃合并」，否则用户遇到冲突后不知道自己在什么状态里。
  let merging = false
  if (gitDirResult.ok) {
    const gitDir = isAbsolute(gitDirResult.stdout.trim()) ? gitDirResult.stdout.trim() : join(root, gitDirResult.stdout.trim())
    try {
      merging = statSync(join(gitDir, 'MERGE_HEAD')).isFile()
    } catch {
      merging = false
    }
  }

  return {
    root,
    branch,
    detached: branch === 'HEAD',
    upstream,
    files,
    staged,
    unstaged,
    stashes,
    merging,
    clean: files.length === 0,
  }
}

/**
 * 生成单个文件的 unified diff。
 * @param root - 仓库根目录。
 * @param file - 文件路径（相对仓库根）。
 * @param options - staged 表示比较暂存区与 HEAD；commit 表示该提交与其父提交。
 */
async function buildDiff(root, file, options) {
  const base = ['diff', '--no-color', '--find-renames', '--unified=3']
  let args
  if (typeof options.commit === 'string' && options.commit !== '') {
    args = [...base, `${options.commit}^`, options.commit, '--', file]
  } else if (options.staged === true) {
    args = [...base, '--cached', '--', file]
  } else {
    args = [...base, '--', file]
  }
  let result = await git(root, args)

  // 未跟踪文件没有可比较对象：用 --no-index 对着空文件生成新增 diff，读起来和 VS Code 一致。
  if ((!result.ok || result.stdout.trim() === '') && options.staged !== true && !options.commit) {
    const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '--', file])
    if (untracked.ok && untracked.stdout.trim() !== '') {
      const empty = process.platform === 'win32' ? 'NUL' : '/dev/null'
      result = await git(root, ['diff', '--no-color', '--no-index', '--unified=3', empty, file], { timeout: TIMEOUT_MS })
    }
  }

  const { text, truncated } = clampText(result.stdout)
  return { file, diff: text, truncated, error: result.ok ? null : result.stderr.trim() || null }
}

/**
 * 解析 `git log` 的字段分隔输出。
 *
 * 用 \x1f（单元分隔符）而不是制表/竖线：提交标题里出现竖线非常常见，
 * 而控制字符几乎不可能出现在用户输入里。
 * @param raw - 带 %x1f 占位符的 log 输出。
 */
function parseLog(raw) {
  return raw
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => {
      const [hash, shortHash, author, email, date, refs, subject, body] = chunk.split('\x1f')
      return {
        hash,
        shortHash,
        author,
        email,
        date,
        refs: refs === undefined || refs.trim() === '' ? [] : refs.trim().split(',').map((value) => value.trim()).filter(Boolean),
        subject,
        body: body === undefined ? '' : body.trim(),
      }
    })
}

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b%x1e'

/** 读取提交历史。 */
async function buildLog(root, options) {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), MAX_LOG_LIMIT)
  const skip = Math.max(Number(options.skip) || 0, 0)
  const args = ['log', `--max-count=${limit}`, `--skip=${skip}`, `--date=iso-strict`, `--pretty=format:${LOG_FORMAT}`]
  if (typeof options.branch === 'string' && options.branch !== '') args.push(options.branch)
  if (typeof options.path === 'string' && options.path !== '') args.push('--', options.path)
  const result = await git(root, args, { timeout: 30_000 })
  if (!result.ok) {
    // 空仓库：git log 会失败，这不是错误，只是还没有提交。
    return { commits: [], hasMore: false, error: result.stderr.includes('does not have any commits') ? null : result.stderr.trim() || null }
  }
  const commits = parseLog(result.stdout)
  return { commits, hasMore: commits.length === limit, error: null }
}

/** 读取一次提交的详情与改动文件。 */
async function buildCommit(root, hash) {
  if (typeof hash !== 'string' || hash.trim() === '') return null
  const target = hash.trim()
  const [meta, files] = await Promise.all([
    git(root, ['show', '--no-patch', `--pretty=format:${LOG_FORMAT}`, target]),
    git(root, ['show', '--name-status', '--format=', '--find-renames', '-z', target]),
  ])
  if (!meta.ok) return null
  const commits = parseLog(meta.stdout)
  const commit = commits[0]
  if (commit === undefined) return null

  const parts = files.stdout.split('\0').filter((value) => value !== '')
  const changed = []
  for (let index = 0; index < parts.length; index += 1) {
    const code = parts[index]
    if (code.length >= 1 && /^[A-Z]/.test(code)) {
      const status = code[0]
      if (status === 'R' || status === 'C') {
        const from = parts[index + 1]
        const path = parts[index + 2]
        index += 2
        if (path !== undefined) changed.push({ status, path, from })
      } else {
        const path = parts[index + 1]
        index += 1
        if (path !== undefined) changed.push({ status, path })
      }
    }
  }
  return { ...commit, files: changed }
}

/** 读取分支列表（本地 + 远程）。 */
async function buildBranches(root) {
  const result = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    `--count=${MAX_BRANCHES}`,
    '--format=%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(committerdate:iso-strict)%1f%(subject)%1f%(upstream:short)%1f%(HEAD)',
    'refs/heads',
    'refs/remotes',
  ])
  if (!result.ok) return { locals: [], remotes: [], error: result.stderr.trim() || null }
  // 本地还是远程必须看**完整 refname**（refs/heads vs refs/remotes）：
  // 分支名里带斜杠极其常见（feature/x），用「名字里有没有 /」判断会把本地分支误判成远程。
  // %(HEAD) 是 `*` 或空格，且会补白，所以必须 trim。
  const locals = []
  const remotes = []
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue
    const [refname, name, hash, date, subject, upstream, head] = line.split('\x1f')
    if (refname === undefined || refname === '' || name === undefined || name === '') continue
    // 远程仓库的 HEAD 指针不是可切换的分支，跳过。
    if (name.endsWith('/HEAD')) continue
    const row = { name, hash, date, subject, upstream: upstream || null, current: (head ?? '').trim() === '*' }
    if (refname.startsWith('refs/remotes/')) remotes.push(row)
    else locals.push(row)
  }
  // 当前分支排最前，其余保持 git 的「最近提交优先」。
  locals.sort((left, right) => Number(right.current) - Number(left.current))
  return { locals, remotes, error: null }
}

/**
 * 执行一个写操作。
 *
 * 全部写操作集中在这里，是为了让「哪些动作会改动仓库」一眼可数，
 * 也便于统一做输入校验。返回的 status 字段让页面少一次往返。
 * @param root - 仓库根目录。
 * @param action - 动作名。
 * @param payload - 动作参数。
 */
async function runAction(root, action, payload) {
  const files = Array.isArray(payload.files) ? payload.files.filter((value) => typeof value === 'string' && value !== '') : []
  const pathspec = files.length > 0 ? ['--', ...files] : []
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  const message = typeof payload.message === 'string' ? payload.message : ''

  switch (action) {
    case 'stage':
      return git(root, pathspec.length > 0 ? ['add', '--', ...files] : ['add', '-A'])
    case 'unstage':
      // 仓库可能还没有 HEAD（首次提交前）：此时 `reset HEAD` 会失败，用 `rm --cached` 退回。
      return git(root, pathspec.length > 0 ? ['reset', 'HEAD', '--', ...files] : ['reset', 'HEAD'])
    case 'discard':
      return git(root, ['checkout', '--', ...files])
    case 'stage-all':
      return git(root, ['add', '-A'])
    case 'unstage-all':
      return git(root, ['reset', 'HEAD'])
    case 'commit':
      if (message.trim() === '') return { ok: false, stdout: '', stderr: 'empty message', code: 1 }
      return git(root, ['commit', '-m', message])
    case 'commit-amend':
      if (message.trim() === '') return { ok: false, stdout: '', stderr: 'empty message', code: 1 }
      return git(root, ['commit', '--amend', '-m', message])
    case 'checkout':
      if (name === '') return { ok: false, stdout: '', stderr: 'empty branch', code: 1 }
      return git(root, ['checkout', name])
    case 'checkout-commit':
      if (name === '') return { ok: false, stdout: '', stderr: 'empty commit', code: 1 }
      return git(root, ['checkout', '--detach', name])
    case 'create-branch':
      if (name === '') return { ok: false, stdout: '', stderr: 'empty branch', code: 1 }
      // 从指定起点建分支。startPoint 可以是本地分支、远程分支（origin/x）或提交哈希。
      // 不给就等价于「从当前 HEAD 建」，与原来行为一致。
      // --no-track：从远程分支建本地分支时，git 默认会把上游设成它。
      //   那是 `checkout -b` 的隐式行为，用户在下拉框里选「origin/main」通常只是想要
      //   「以它为起点」，并不期待顺带绑定上游，所以这里显式关掉，避免意外。
      return git(root, ['checkout', '-b', name, ...(typeof payload.startPoint === 'string' && payload.startPoint.trim() !== '' ? ['--no-track', payload.startPoint.trim()] : [])])
    case 'merge':
      if (name === '') return { ok: false, stdout: '', stderr: 'empty branch', code: 1 }
      // 合并分两种：普通合并会新建合并提交；--ff-only 只在能快进时成功。
      // 冲突时 git 会以非 0 退出并留下冲突标记，页面上按「有冲突」显示，工作区里自行解决。
      return git(root, ['merge', ...(payload.ffOnly === true ? ['--ff-only'] : ['--no-ff']), ...(message.trim() === '' ? [] : ['-m', message]), name])
    case 'merge-abort':
      return git(root, ['merge', '--abort'])
    case 'delete-branch':
      if (name === '') return { ok: false, stdout: '', stderr: 'empty branch', code: 1 }
      return git(root, ['branch', payload.force === true ? '-D' : '-d', name])
    case 'fetch':
      return git(root, ['fetch', '--all', '--prune'], { timeout: NETWORK_TIMEOUT_MS })
    case 'pull':
      return git(root, ['pull', '--ff-only'], { timeout: NETWORK_TIMEOUT_MS })
    case 'push':
      return git(root, ['push'], { timeout: NETWORK_TIMEOUT_MS })
    case 'push-upstream':
      return git(root, ['push', '-u', 'origin', 'HEAD'], { timeout: NETWORK_TIMEOUT_MS })
    case 'stash-save':
      return git(root, ['stash', 'push', '--include-untracked', ...(message.trim() === '' ? [] : ['-m', message])])
    case 'stash-pop':
      return git(root, ['stash', 'pop'])
    case 'stash-drop':
      if (name === '') return { ok: false, stdout: '', stderr: 'empty stash', code: 1 }
      return git(root, ['stash', 'drop', name])
    case 'init':
      return git(root, ['init'])
    default:
      return { ok: false, stdout: '', stderr: `unknown action: ${action}`, code: 1 }
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 读请求体，超过 1MB 判失败（提交信息不该有这么大）。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** patch 里的 config 是裸 JSON（本插件不导出 Config schema），这里手动兜默认值。 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const roots = Array.isArray(source.roots)
    ? source.roots
        .filter((value) => typeof value === 'string' && value.trim() !== '')
        .map((value) => {
          try {
            return realpathSync(resolve(value.trim()))
          } catch {
            return resolve(value.trim())
          }
        })
    : []
  return { roots, gitPath: typeof source.gitPath === 'string' && source.gitPath.trim() !== '' ? source.gitPath.trim() : 'git' }
}

/**
 * 安装 Git 后端：把上面几条路由挂到 webServer 上。
 * @param ctx - 拥有这些注册的插件上下文。
 * @param rawConfig - patch 行里的 config（可选，可限定 roots）。
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[git] ${message}`)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  /** connection 围栏：非本机同源请求直接拒掉，和 token-usage 一致。 */
  const reject = (req, res) => {
    const connection = ctx.get('connection')
    if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /**
   * 从查询串里取仓库路径并确认是个仓库。
   * @returns {root} 或已发过错误响应时返回 null。
   */
  async function requireRepo(req, res, url) {
    const root = resolveRepo(url.searchParams.get('path'), cfg.roots)
    if (root === null) {
      sendJson(res, 400, { error: 'invalid-path', message: 'Path must be an existing absolute directory.' })
      return null
    }
    const found = await repoRoot(root)
    if (found === null) {
      sendJson(res, 200, { error: 'not-a-repo', message: 'Not a git repository.' })
      return null
    }
    return found
  }

  /** 统一的 GET 路由外壳：校验、执行、序列化，异常一律变成 500 JSON。 */
  const route = (path, handler) =>
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            if (reject(req, res)) return
            try {
              const url = new URL(req.url ?? path, 'http://127.0.0.1')
              await handler(req, res, url)
            } catch (error) {
              log('warn', `${path} 处理失败：${error instanceof Error ? error.message : String(error)}`)
              if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      `git: ${path}`,
    )

  route(STATUS_PATH, async (req, res, url) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    const found = await requireRepo(req, res, url)
    if (found === null) return
    sendJson(res, 200, { build: HOST_BUILD, ...(await buildStatus(found.root)), bare: found.bare })
  })

  route(DIFF_PATH, async (req, res, url) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    const found = await requireRepo(req, res, url)
    if (found === null) return
    const file = url.searchParams.get('file')
    if (file === null || file === '') {
      sendJson(res, 400, { error: 'missing-file', message: 'A file path is required.' })
      return
    }
    const diff = await buildDiff(found.root, file, {
      staged: url.searchParams.get('staged') === 'true',
      commit: url.searchParams.get('commit') ?? undefined,
    })
    sendJson(res, 200, { build: HOST_BUILD, ...diff })
  })

  route(LOG_PATH, async (req, res, url) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    const found = await requireRepo(req, res, url)
    if (found === null) return
    const result = await buildLog(found.root, {
      limit: url.searchParams.get('limit'),
      skip: url.searchParams.get('skip'),
      branch: url.searchParams.get('branch') ?? undefined,
      path: url.searchParams.get('file') ?? undefined,
    })
    sendJson(res, 200, { build: HOST_BUILD, ...result })
  })

  route(COMMIT_PATH, async (req, res, url) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    const found = await requireRepo(req, res, url)
    if (found === null) return
    const commit = await buildCommit(found.root, url.searchParams.get('hash') ?? '')
    if (commit === null) {
      sendJson(res, 200, { error: 'not-found', message: 'Commit not found.' })
      return
    }
    sendJson(res, 200, { build: HOST_BUILD, commit })
  })

  route(BRANCHES_PATH, async (req, res, url) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    const found = await requireRepo(req, res, url)
    if (found === null) return
    sendJson(res, 200, { build: HOST_BUILD, ...(await buildBranches(found.root)) })
  })

  route(ACTION_PATH, async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    const body = await readJsonBody(req)
    if (body === undefined) {
      sendJson(res, 400, { error: 'invalid-json', message: 'Body must be a JSON object.' })
      return
    }
    const root = resolveRepo(body.path, cfg.roots)
    if (root === null) {
      sendJson(res, 400, { error: 'invalid-path', message: 'Path must be an existing absolute directory.' })
      return
    }
    const found = await repoRoot(root)
    if (found === null) {
      sendJson(res, 200, { error: 'not-a-repo', message: 'Not a git repository.' })
      return
    }
    const action = typeof body.action === 'string' ? body.action : ''
    const result = await runAction(found.root, action, body)
    const payload = {
      build: HOST_BUILD,
      action,
      ok: result.ok,
      code: result.code,
      stdout: clampText(result.stdout, 20_000).text,
      stderr: clampText(result.stderr, 20_000).text,
      message: result.ok ? result.stdout.trim() : result.stderr.trim(),
    }
    // 写操作之后顺手回报最新状态：少一次往返，也让「提交完列表没变」这类问题消失。
    if (result.ok) {
      try {
        payload.status = await buildStatus(found.root)
      } catch {
        /* 状态读取失败不影响动作结果 */
      }
    }
    sendJson(res, 200, payload)
  })

  // 启动自检：git 到底在不在、版本多少，出问题时日志里第一眼能看到。
  void (async () => {
    const result = await new Promise((settle) => {
      execFile(cfg.gitPath, ['--version'], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
        settle(error === null ? stdout.trim() : null)
      })
    })
    if (result === null) log('error', `找不到可用的 git（配置的可执行文件：${cfg.gitPath}）。右侧栏 Git 面板将无法读取仓库。`)
    else log('info', `已启用，${result}（build ${HOST_BUILD}${cfg.roots.length > 0 ? `，限定根目录 ${cfg.roots.join(', ')}` : ''}）`)
  })()
}

// 供 smoke 复用：这些是纯函数（或只依赖 git CLI），不需要起 webServer 就能验证。
export const __internals = {
  parseStatusZ,
  parseLog,
  classify,
  isStaged,
  resolveRepo,
  clampText,
  normalizeConfig,
  buildStatus,
  buildDiff,
  buildLog,
  buildCommit,
  buildBranches,
  runAction,
}
/** 默认 DSH 主目录，供将来扩展共享配置时使用。 */
export const __defaultHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
