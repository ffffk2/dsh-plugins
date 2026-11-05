/**
 * Git 提交与 PR —— Host 半。
 *
 * 三个斜杠命令，发出去就干活，不需要模型从头「照着说明书敲 git」：
 *
 *   /commit [路径…|说明]          暂存 → 生成提交信息 → 本地提交（不推送）
 *   /create-pr [目标分支] [说明]   推送当前分支 → 建 PR/MR
 *   /commit-pr [目标分支] [说明]   提交 + 推送 + 建 PR，一条命令走完
 *
 * 设计要点（为什么不做成提示词模板）：
 *   - 提示词模板每次都要模型重新读一遍规则、重新拼 git 命令，既慢又会在细节上漂移。
 *     这里把「检查 → 扫描 → 暂存 → 提交 → 推送 → 建 PR」固化成确定性代码，模型只负责
 *     **写文案**（提交信息、PR 标题与正文），那也是唯一真正需要模型判断的部分。
 *   - 模型不可用 / 未配置时不让功能瘫掉：退化成「按改动推断主题行」，并如实说明
 *     「本次提交信息由规则生成，未调用模型」——而不是假装模型写过。
 *   - 平台按远端 URL 自动判定（GitHub / GitLab / 其他），失败时一路降级：
 *     gh/glab CLI 已登录 → 环境变量 token 调 REST API → 给出预填网页链接。
 *     降级链的每一级都在结果里写明用了哪条路，让人知道为什么退到了链接。
 *
 * 安全约定：
 *   - 不改 `.git/config`、不写任何凭据文件；token 只从环境变量读，绝不回显。
 *   - 不用 `--force` / `--force-with-lease`，不用 `--no-verify`。
 *   - **暂存之前**就扫描凭据文件与密钥字面量：命中直接返回，索引一动没动，
 *     用户已经暂存好的东西不会被我们回滚。
 *   - 所有 git 调用走 `execFile('git', [...args])`（数组、不开 shell），
 *     分支名与路径里的空格引号不需要转义，也不存在命令拼接注入。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Cordis 插件名（必须等于 cordis.patch.yml 里的行 id）。 */
export const name = 'git-pr'
/**
 * 只需要命令注册表。
 *
 * 其余服务（scripts 用到的 workingDirectory / llm / tools / agentDefaultModel）
 * 一律走 `ctx.get(...)` 可选获取：缺了它们功能退化，但不该让整个插件不激活。
 */
export const inject = ['commands']

/**
 * Host 半的代码版本号。
 *
 * 改了这个文件必须重启 DSH 才会生效（Node 会缓存已导入的 ES module）。
 * **每次改这个文件都顺手加一。**
 */
const HOST_BUILD = 1

/** 普通 git 命令超时。 */
const TIMEOUT_MS = 20_000
/** 写操作（commit 要扫一遍工作区）超时。 */
const WRITE_TIMEOUT_MS = 120_000
/** 网络命令（fetch/push/ls-remote、gh/glab）超时。 */
const NETWORK_TIMEOUT_MS = 120_000
/** 单条命令 stdout 上限，防止巨型 diff 撑爆内存。 */
const MAX_BUFFER = 32 * 1024 * 1024
/** 拼进模型提示词的最大 diff 字符数。 */
const MAX_PROMPT_DIFF = 24_000
/** 列出改动文件的上限。 */
const MAX_FILES = 400
/** 参与安全扫描的文件数上限。 */
const MAX_SCAN_FILES = 400
/** 未跟踪文件内容扫描的单个文件上限。 */
const MAX_SCAN_BYTES = 1024 * 1024
/** 提交里单个文件的体积上限：再大基本就是误提交的二进制。 */
const MAX_COMMIT_FILE_BYTES = 5 * 1024 * 1024
/** 辅助文案调用的等待上限。 */
const COPY_TIMEOUT_MS = 45_000
/** 辅助调用允许的最大输出 token。 */
const COPY_MAX_TOKENS = 900
/** 主题行字符上限（按 Unicode 码点，中文也算一个）。 */
const MAX_SUBJECT_CHARS = 72

/** 凭据类文件名：出现即拦截（`git add -A` 会把未跟踪的它们也吃进去）。 */
const SECRET_FILE_PATTERNS = [
  /(^|[/\\])\.env(\..+)?$/iu,
  /\.pem$/iu,
  /\.key$/iu,
  /\.p12$/iu,
  /\.pfx$/iu,
  /\.jks$/iu,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/iu,
  /(^|[/\\])credentials?(\..+)?$/iu,
  /(^|[/\\])\.credentials\.yaml$/iu,
  /(^|[/\\])\.npmrc$/iu,
  /(^|[/\\])\.netrc$/iu,
]

/**
 * 密钥字面量：只匹配「赋值号右边是一段像密钥的字符串」。
 *
 * 所以 `password: process.env.X`、`token = readConfig()`、`secret: 'REPLACE_ME'`
 * 都不会误伤。误报的代价比漏报更大——用户被拦两次就会绕开扫描。
 */
const SECRET_VALUE_PATTERNS = [
  { label: 'private-key-block', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/u },
  {
    label: 'secret-literal',
    re: /(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*['"`](?!\$\{|<|REPLACE|CHANGE|YOUR_|EXAMPLE|xxx|placeholder)[^'"`\s]{8,}['"`]/iu,
  },
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/u },
  { label: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/u },
  { label: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}/u },
  { label: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/u },
  { label: 'provider-key', re: /\bsk-[A-Za-z0-9]{20,}/u },
]

/**
 * 执行一次 git 命令。
 *
 * `-c core.quotepath=false` 让中文文件名原样输出（默认会转义成 \ooo 八进制）；
 * `GIT_TERMINAL_PROMPT=0` 保证需要凭据时**立刻失败**而不是挂在那里等输入。
 * 一律不抛异常：git 失败也是一种正常结果，由调用方决定怎么呈现。
 * @param cwd - 工作目录。
 * @param args - git 子命令与参数，数组传递、不经 shell。
 * @param options - 超时覆盖。
 * @returns {ok, stdout, stderr, code, killed}
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
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_PAGER: 'cat',
          GIT_EDITOR: 'true',
          // 网络命令需要凭据时立刻失败，而不是把宿主挂住等交互输入。
          GIT_TERMINAL_PROMPT: '0',
        },
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

/** 截断长文本并注明截断。 */
function clamp(text, max = 4_000) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}

/** 按 Unicode 码点截断（中文不会被切成半个字符）。 */
function clampChars(text, max) {
  const chars = Array.from(typeof text === 'string' ? text : '')
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

/** 去掉首尾空白与包裹的引号/反引号，模型偶尔会带出来。 */
function unwrap(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const match = /^(["'`])([\s\S]*)\1$/u.exec(trimmed)
  return match === null ? trimmed : match[2].trim()
}

/**
 * 确认目录在一个 git 仓库里。
 * @param cwd - 起始目录（必须是绝对路径且真实存在）。
 * @returns {root, prefix} 或 null。
 */
async function repoOf(cwd) {
  if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) return null
  let real
  try {
    real = realpathSync(resolve(cwd))
    if (!statSync(real).isDirectory()) return null
  } catch {
    return null
  }
  const top = await git(real, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return null
  // 直接用 git 报出来的绝对路径当下面的 cwd：Windows 上它可能是 8.3 短名、
  // 斜杠方向也由 git 决定，自己 realpath 一遍反而会和它算不到一起去。
  const root = top.stdout.trim()
  if (root === '') return null
  // 相对仓库根的前缀同样交给 git 算（--show-prefix），避免路径规范化差异。
  const prefix = await git(real, ['rev-parse', '--show-prefix'])
  return { root, prefix: prefix.ok ? prefix.stdout.trim() : '' }
}

/**
 * 把一个用户给的路径 token 变成 git 认得的「仓库内相对路径」。
 *
 * 不自己拼 relative()：Windows 上 `C:\Users\ABCDEF~1.4\...` 与
 * `C:\Users\abcdef\...` 是同一个目录，一比较就会算出一串 `..`。
 * 让 git 自己回答 `--show-prefix`，短名、符号链接、大小写全都不用管。
 * @param cwd - 用户当前目录（相对路径按它解析）。
 * @param token - 用户输入的单个路径。
 * @returns 仓库内相对路径，或 null 表示不在仓库里/不存在。
 */
async function repoPathFrom(cwd, token) {
  const full = isAbsolute(token) ? resolve(token) : resolve(cwd, token)
  let info
  try {
    info = statSync(full)
  } catch {
    return null
  }
  const isDir = info.isDirectory()
  const dir = isDir ? full : dirname(full)
  const prefix = await git(dir, ['rev-parse', '--show-prefix'])
  // 不在任何仓库里时这条命令会失败——正合适，仓库外的路径本来就不该 add。
  if (!prefix.ok) return null
  const relativeDir = prefix.stdout.trim()
  if (isDir) return relativeDir === '' ? '.' : relativeDir.replace(/\/+$/u, '')
  return `${relativeDir}${basename(full)}`
}

/** 当前分支；detached HEAD 时返回空串。 */
async function currentBranch(root) {
  const result = await git(root, ['branch', '--show-current'])
  return result.ok ? result.stdout.trim() : ''
}

/**
 * 解析 porcelain v1 `-z`。
 *
 * 用 `-z` 而不是普通输出：NUL 分隔是唯一无歧义的格式，重命名的原路径也靠它配对。
 * @param raw - `git status --porcelain=v1 -z` 的原始输出。
 * @returns {x, y, path, staged, untracked}[]
 */
function parseStatus(raw) {
  const entries = []
  const parts = raw.split('\0')
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part.length < 4) continue
    const x = part[0]
    const y = part[1]
    const path = part.slice(3)
    // 重命名/复制条目后面跟着一条原路径，跳过它（否则会被当成第二个文件）。
    if (x === 'R' || x === 'C') index += 1
    if (path === '') continue
    entries.push({ x, y, path, staged: x !== ' ' && x !== '?', untracked: x === '?' && y === '?' })
  }
  return entries
}

/** 工作区状态。 */
async function statusOf(root) {
  const result = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  return result.ok ? parseStatus(result.stdout) : []
}

/** origin（没有就用第一个 remote）的 URL。 */
async function originUrl(root) {
  const origin = await git(root, ['remote', 'get-url', 'origin'])
  if (origin.ok && origin.stdout.trim() !== '') return { url: origin.stdout.trim(), name: 'origin' }
  const list = await git(root, ['remote'])
  const first = list.ok ? list.stdout.split('\n').map((line) => line.trim()).filter(Boolean)[0] : undefined
  if (first === undefined) return { url: '', name: '' }
  const other = await git(root, ['remote', 'get-url', first])
  return other.ok ? { url: other.stdout.trim(), name: first } : { url: '', name: '' }
}

/**
 * 把远端 URL 归一化成平台信息。
 *
 * 三种写法都认：`git@host:owner/repo.git`、`ssh://git@host/owner/repo.git`、
 * `https://host/owner/repo.git`。自建 GitLab 常有多层命名空间，owner 保留完整层级。
 *
 * 本地路径形式的远端（`C:\repo.git`、`../remote.git`、`file:///…`）返回一个
 * `kind: 'local'` 的结果而不是 null：这种仓库**能推**，只是没有 PR 平台。
 * 若返回 null 就会得到「认不出远端地址」，把「这是个本地 clone」误导成配置错误。
 * @param url - `git remote get-url` 的原始输出。
 * @returns {host, webBase, owner, repo, kind} 或 null。
 */
function parseRemote(url) {
  if (typeof url !== 'string') return null
  const text = url.trim()
  if (text === '') return null
  if (/^file:\/\//iu.test(text)) {
    try {
      const parsed = new URL(text)
      return { host: parsed.host, webBase: '', owner: '', repo: basename(parsed.pathname.replace(/[\\/]+$/u, '')), kind: 'local' }
    } catch {
      return null
    }
  }
  // 本地路径远端：盘符路径、UNC、以及不可能是 host 的 `../foo`。
  if (/^[A-Za-z]:[/\\]/u.test(text) || /^\\\\/u.test(text) || text.startsWith('.')) {
    return { host: '', webBase: '', owner: '', repo: basename(text.replace(/[\\/]+$/u, '')), kind: 'local' }
  }
  let host = ''
  let pathname = ''
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    try {
      const parsed = new URL(text)
      host = parsed.host
      pathname = parsed.pathname
    } catch {
      return null
    }
  } else {
    // scp 风格 `user@host:owner/repo`。
    const scp = /^(?:[^@/]+@)?([^:/]+):(.*)$/u.exec(text)
    if (scp === null) return null
    host = scp[1]
    pathname = scp[2]
  }
  const cleaned = pathname.replace(/^\/+/u, '').replace(/\.git$/iu, '').replace(/\/+$/u, '')
  const segments = cleaned.split('/').filter(Boolean)
  if (host === '' || segments.length < 2) return null
  const repo = segments[segments.length - 1]
  const owner = segments.slice(0, -1).join('/')
  const lowerHost = host.toLowerCase()
  // 平台判定只看主机名：仓库名里出现 "github" 不代表它在 GitHub。
  const kind = lowerHost.includes('github')
    ? 'github'
    : lowerHost.includes('gitlab')
      ? 'gitlab'
      : lowerHost.includes('gitea') || lowerHost.includes('forgejo')
        ? 'gitea'
        : 'other'
  return { host, webBase: `https://${host}/${owner}/${repo}`, owner, repo, kind }
}

/**
 * 远端是否存在某个分支。
 *
 * 先看本地已有的远端跟踪分支（快，且**离线也能答**），没有才去问远端。
 * 不把 `ls-remote` 的失败直接当成「分支不存在」：断网、代理没配、凭据过期都会让它
 * 失败，那时把「离线」说成「没有这个分支」是最误导人的一种报错。
 */
async function remoteBranchExists(root, branch, remote = 'origin') {
  if (typeof branch !== 'string' || branch === '') return false
  const tracking = await git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`])
  if (tracking.ok) return true
  const result = await git(root, ['ls-remote', '--heads', remote, branch], { timeout: NETWORK_TIMEOUT_MS })
  return result.ok && result.stdout.trim() !== ''
}

/** 远端默认分支：origin/HEAD → ls-remote --symref → main → master → 远端第一个分支。 */
async function defaultBase(root, remote = 'origin') {
  const symbolic = await git(root, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])
  if (symbolic.ok) {
    const name = symbolic.stdout.trim().replace(new RegExp(`^${remote}/`, 'u'), '')
    if (name !== '') return name
  }
  const remoteHead = await git(root, ['ls-remote', '--symref', remote, 'HEAD'], { timeout: NETWORK_TIMEOUT_MS })
  if (remoteHead.ok) {
    const match = /ref:\s+refs\/heads\/(\S+)\s+HEAD/u.exec(remoteHead.stdout)
    if (match !== null) return match[1]
  }
  for (const candidate of ['main', 'master']) {
    if (await remoteBranchExists(root, candidate, remote)) return candidate
  }
  const heads = await git(root, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`], { timeout: NETWORK_TIMEOUT_MS })
  if (heads.ok) {
    const first = heads.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.endsWith('/HEAD'))
      .map((line) => line.replace(new RegExp(`^${remote}/`, 'u'), ''))[0]
    if (first !== undefined) return first
  }
  return 'main'
}

/** 是否已有上游分支。 */
async function hasUpstream(root) {
  const result = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  return result.ok && result.stdout.trim() !== ''
}

/** 领先 base 的提交（`<hash> <subject>`，新→旧）。 */
async function commitsAhead(root, base, remote = 'origin', limit = 20) {
  if (typeof base !== 'string' || base === '') return []
  const result = await git(root, ['log', `${remote}/${base}..HEAD`, '--oneline', `-${limit}`])
  if (result.ok) return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  // 远端基线还没 fetch 过时 origin/<base> 可能不存在，退回本地比对。
  const local = await git(root, ['log', `${base}..HEAD`, '--oneline', `-${limit}`])
  return local.ok ? local.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
}

/** 最近 N 条提交的主题行（学习提交信息的语言与格式）。 */
async function recentCommits(root, limit = 20) {
  const result = await git(root, ['log', `-${limit}`, '--pretty=format:%s'])
  return result.ok ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
}

/**
 * 收集改动上下文（写提示词与给用户看）。
 * @param root - 仓库根。
 * @param stage - 'worktree' 看未暂存，'staged' 看已暂存。
 */
async function changeContext(root, stage = 'worktree') {
  const extra = stage === 'staged' ? ['--cached'] : []
  const stat = await git(root, ['diff', '--stat', ...extra])
  const diff = await git(root, ['diff', ...extra])
  const entries = await statusOf(root)
  return {
    stat: stat.ok ? clamp(stat.stdout, 6_000) : '',
    diff: diff.ok ? clamp(diff.stdout, MAX_PROMPT_DIFF) : '',
    files: entries.slice(0, MAX_FILES).map((entry) => `${entry.x}${entry.y} ${entry.path}`),
    entries,
  }
}

/** 文件名是否命中凭据文件规则。 */
function isSecretPath(path) {
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(path))
}

/** 一段文本里命中的密钥类型。 */
function secretKinds(text) {
  const kinds = []
  for (const { label, re } of SECRET_VALUE_PATTERNS) {
    if (re.test(text)) kinds.push(label)
  }
  return kinds
}

/**
 * 暂存**之前**的安全扫描。
 *
 * 顺序是刻意的：一旦先 `git add` 再发现密钥，撤销暂存就会连带把用户自己
 * 已经 `git add` 过的东西一起清掉。所以先在将要提交的内容上判定，
 * 命中就一个字都不动。
 * @param root - 仓库根。
 * @param entries - `statusOf` 的结果。
 * @returns 命中列表；空数组表示干净。
 */
async function scanBeforeStage(root, entries) {
  const hits = []
  const tracked = []
  for (const entry of entries.slice(0, MAX_SCAN_FILES)) {
    if (isSecretPath(entry.path)) {
      hits.push({ path: entry.path, reason: 'credential-file' })
      continue
    }
    const full = join(root, entry.path)
    let size = 0
    try {
      size = statSync(full).size
    } catch {
      continue
    }
    if (size > MAX_COMMIT_FILE_BYTES) {
      hits.push({ path: entry.path, reason: `file-too-large（${(size / 1024 / 1024).toFixed(1)} MB）` })
      continue
    }
    if (entry.untracked && size <= MAX_SCAN_BYTES) {
      // 未跟踪文件的内容不在 git diff 里，只能自己读。
      try {
        for (const kind of secretKinds(readFileSync(full, 'utf8'))) hits.push({ path: entry.path, reason: kind })
      } catch {
        /* 二进制或读不出来就跳过，别让扫描本身把提交挡死 */
      }
    } else if (!entry.untracked) {
      tracked.push(entry.path)
    }
  }
  // 已跟踪文件的改动看 diff 的新增行：删除行是「曾经有过」，不是这次要提交进去的内容。
  if (tracked.length > 0) {
    const diff = await git(root, ['diff', '--unified=0', '--', ...tracked.slice(0, MAX_SCAN_FILES)])
    if (diff.ok) {
      let file = ''
      for (const line of diff.stdout.split('\n')) {
        if (line.startsWith('+++ b/')) {
          file = line.slice(6)
          continue
        }
        if (!line.startsWith('+') || line.startsWith('+++')) continue
        for (const kind of secretKinds(line)) hits.push({ path: file, reason: kind })
        if (hits.length >= 40) break
      }
    }
  }
  return hits
}

/**
 * 从改动里推断一个提交主题行（模型不可用时的兜底）。
 *
 * 只做最保守的事：取第一个改动所在的目录或文件名，加一个动词。
 * 明显不如模型，但比空提交信息强，且调用方会明确标注「规则生成」。
 */
function fallbackSubject(entries, hint) {
  if (typeof hint === 'string' && hint.trim() !== '') return clampChars(hint.trim(), MAX_SUBJECT_CHARS)
  if (entries.length === 0) return 'chore: 更新'
  const first = entries[0].path
  const scope = first.includes('/') ? first.slice(0, first.indexOf('/')) : first
  const verb = entries.every((entry) => entry.untracked) ? '新增' : '更新'
  return clampChars(`${verb} ${scope}（${entries.length} 个文件）`, MAX_SUBJECT_CHARS)
}

// ---------------------------------------------------------------------------
// 辅助模型调用：只负责写文案
// ---------------------------------------------------------------------------

/**
 * 解析辅助调用要用的 provider/model。
 *
 * 优先级：插件配置 > 会话最近一次请求的路由 > 宿主默认选择。
 * 都没有就返回 null，调用方据此退回规则生成的文案——辅助调用是**增强**，
 * 不是前置条件。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 * @param agent - 触发命令的 agent（可能没有）。
 * @returns {provider, model} 或 null。
 */
function resolveCopyRoute(ctx, config, agent) {
  if (config.provider !== '' && config.model !== '') return { provider: config.provider, model: config.model }
  try {
    const header = agent?.session?.requestHeader?.()
    const route = header?.config
    if (typeof route?.provider === 'string' && typeof route?.model === 'string') return { provider: route.provider, model: route.model }
  } catch {
    /* 会话还没发过请求时没有 header，继续往下找 */
  }
  const fallback = ctx.get('agentDefaultModel')
  if (fallback !== undefined && fallback !== null && typeof fallback.currentSelection === 'function') {
    try {
      const current = fallback.currentSelection()
      if (typeof current?.provider === 'string' && typeof current?.model === 'string') {
        return { provider: current.provider, model: current.model }
      }
    } catch {
      /* 读不到就走规则兜底 */
    }
  }
  return null
}

/**
 * 取出辅助调用的文本结果。
 *
 * 只取 `block-end` 的 text 块：`text-delta` 是同一段文本的分片，两者相加会重复。
 */
function assembledText(chunks) {
  const blocks = []
  const deltas = []
  for (const chunk of chunks) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') deltas.push(chunk.text)
    else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') blocks.push(chunk.block.text)
  }
  return (blocks.length > 0 ? blocks.join('') : deltas.join('')).trim()
}

/**
 * 让模型写一段交付文案。
 *
 * 不用 `purpose` 字段：那个枚举是 compaction / session-title 这些内部任务预留的，
 * 插件占用它会污染其它消费者的统计口径。
 * @returns 文本，或 null 表示不可用。
 */
async function askModel(ctx, route, system, user, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || typeof llm.prepareCall !== 'function') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('copy timeout')), COPY_TIMEOUT_MS)
  const composed = signal === undefined || signal === null ? controller.signal : AbortSignal.any([signal, controller.signal])
  try {
    const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: COPY_MAX_TOKENS }, composed)
    const chunks = []
    for await (const chunk of call.stream({
      ...call.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      system,
      signal: composed,
    })) {
      chunks.push(chunk)
    }
    const text = assembledText(chunks)
    return text === '' ? null : text
  } catch {
    // 模型不可用不是功能故障：调用方会退回规则文案并如实说明。
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 提交信息的提示词。显式禁止署名，因为多数模型默认爱加。 */
const COMMIT_SYSTEM = [
  '你是资深工程师，负责为一个 Git 提交写提交信息。',
  '只输出提交信息本身：不要代码围栏、不要解释、不要前后缀。',
  '第一行是主题行，不超过 72 个字符，动词开头，说清「做了什么」；不要写「修改了一些代码」这类空话。',
  '语言与格式跟随给出的历史提交：历史用 Conventional Commits（feat:/fix:/refactor:…）就沿用；',
  '历史是纯中文描述就用中文；两者都不明显时用 Conventional Commits，主题行可用中文。',
  '只有需要解释原因、影响面或权衡时才写正文；正文每行不超过 72 字符，与主题行之间空一行。',
  '破坏性变更在主题行加 ! 并在正文写 BREAKING CHANGE: 脚注。',
  '绝不添加 "Generated with …"、"Co-authored-by" 之类的工具署名。',
].join('\n')

/** PR 文案的提示词。 */
const PR_SYSTEM = [
  '你是资深工程师，负责为一个 Pull Request 写标题和正文。',
  '正文只写能从提交与 diff 确认的事实；绝不编造测试结果或性能数据。',
  '输出严格用下面两段，不要加别的标题或解释：',
  'TITLE: <不超过 72 字符的标题>',
  'BODY:',
  '<Markdown 正文>',
  '正文结构：先「## 变更内容」用列表写清改了什么，再「## 验证」写实际做过的检查；',
  '确实没有运行测试时才写「未运行自动化测试」。',
  '语言跟随仓库历史提交。',
].join('\n')

/** 把模型输出解析成 {title, body}。 */
function parsePrCopy(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const cleaned = text.replace(/^```[a-z]*\n?/iu, '').replace(/```$/u, '').trim()
  const titleMatch = /^[ \t]*TITLE:[ \t]*(.+)$/imu.exec(cleaned)
  const bodyMatch = /^[ \t]*BODY:[ \t]*$/imu.exec(cleaned)
  const title = titleMatch === null ? '' : unwrap(titleMatch[1])
  const body =
    bodyMatch === null
      ? cleaned.replace(/^[ \t]*TITLE:.*$/imu, '').trim()
      : cleaned.slice(cleaned.indexOf('\n', bodyMatch.index) + 1).trim() === ''
        ? ''
        : cleaned.slice(cleaned.indexOf('\n', bodyMatch.index) + 1).trim()
  if (title === '' && body === '') return null
  const subject = title === '' ? (body.split('\n').find((line) => line.trim() !== '') ?? '') : title
  return { title: clampChars(subject, MAX_SUBJECT_CHARS), body }
}

// ---------------------------------------------------------------------------
// PR 平台：gh/glab → token REST → 预填网页链接
// ---------------------------------------------------------------------------

/** 尝试执行一个命令，返回成功与否（不抛异常）。 */
function tryExec(root, command, args, timeout = TIMEOUT_MS) {
  return new Promise((settle) => {
    execFile(command, args, { cwd: root, timeout, windowsHide: true, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      settle({ ok: error === null, stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' })
    })
  })
}

/** 从若干候选环境变量里取第一个非空值（token 绝不回显）。 */
function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 平台的 REST API 基址。 */
function apiBaseOf(remote) {
  if (remote.kind === 'github') {
    return remote.host.toLowerCase() === 'github.com' ? 'https://api.github.com' : `https://${remote.host}/api/v3`
  }
  return `https://${remote.host}/api/v4`
}

/** 查已存在的同 head 的 PR/MR 链接。 */
async function findExisting(remote, token, head, base) {
  const isGithub = remote.kind === 'github'
  const base_ = apiBaseOf(remote)
  const url = isGithub
    ? `${base_}/repos/${remote.owner}/${remote.repo}/pulls?state=open&head=${encodeURIComponent(`${remote.owner}:${head}`)}`
    : `${base_}/projects/${encodeURIComponent(`${remote.owner}/${remote.repo}`)}/merge_requests?state=opened&source_branch=${encodeURIComponent(head)}&target_branch=${encodeURIComponent(base)}`
  try {
    const response = await fetch(url, {
      headers: isGithub
        ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-git-pr' }
        : { 'private-token': token, 'user-agent': 'dsh-git-pr' },
    })
    if (!response.ok) return null
    const list = await response.json()
    const first = Array.isArray(list) ? list[0] : undefined
    if (first === undefined) return null
    return typeof first.html_url === 'string' ? first.html_url : typeof first.web_url === 'string' ? first.web_url : null
  } catch {
    return null
  }
}

/**
 * 调 REST API 建 PR/MR。
 * @returns {ok, url, number, existing, error, method}
 */
async function createViaApi(remote, token, head, base, title, body) {
  const isGithub = remote.kind === 'github'
  const endpoint = isGithub
    ? `${apiBaseOf(remote)}/repos/${remote.owner}/${remote.repo}/pulls`
    : `${apiBaseOf(remote)}/projects/${encodeURIComponent(`${remote.owner}/${remote.repo}`)}/merge_requests`
  const payload = isGithub
    ? { title, head, base, body, maintainer_can_modify: true }
    : { title, source_branch: head, target_branch: base, description: body }
  const headers = isGithub
    ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'dsh-git-pr' }
    : { 'private-token': token, 'content-type': 'application/json', 'user-agent': 'dsh-git-pr' }
  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!response.ok) {
      // 422/409 里「已存在」最常见：顺手把现有那个找出来，别让人重复建。
      if (response.status === 422 || response.status === 409) {
        const existing = await findExisting(remote, token, head, base)
        if (existing !== null) return { ok: true, url: existing, existing: true, method: 'api' }
      }
      const message =
        typeof parsed?.message === 'string'
          ? parsed.message
          : Array.isArray(parsed?.errors)
            ? parsed.errors.map((entry) => entry?.message ?? String(entry)).join('; ')
            : clamp(text, 600)
      return { ok: false, status: response.status, error: `HTTP ${response.status}：${message}`, method: 'api' }
    }
    return {
      ok: true,
      url: typeof parsed?.html_url === 'string' ? parsed.html_url : typeof parsed?.web_url === 'string' ? parsed.web_url : remote.webBase,
      number: typeof parsed?.number === 'number' ? parsed.number : typeof parsed?.iid === 'number' ? parsed.iid : undefined,
      existing: false,
      method: 'api',
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), method: 'api' }
  }
}

/** 预填网页链接：没有 CLI、没有 token 时的最后一级，**永远**可用。 */
function compareUrl(remote, base, head, title, body) {
  if (remote.kind === 'gitlab') {
    const params = new URLSearchParams({
      'merge_request[source_branch]': head,
      'merge_request[target_branch]': base,
      'merge_request[title]': title,
    })
    return `${remote.webBase}/-/merge_requests/new?${params.toString()}`
  }
  const params = new URLSearchParams({ expand: '1', title })
  if (body.trim() !== '') params.set('body', body)
  const path =
    remote.kind === 'github'
      ? `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
      : `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  return `${remote.webBase}${path}?${params.toString()}`
}

/**
 * 按降级顺序创建 PR/MR。
 *
 * 顺序刻意如此：CLI 最省事（用户已经用它登录过），token 次之（适合 CI/无人值守），
 * 网页链接兜底（只是打开浏览器，所以永远能成功）。每一级失败都继续降级，
 * 但会把上一级的错误一并回报——否则「明明能建却只给了链接」会让人一头雾水。
 * @returns {ok, url, method, number, existing, error, attempts}
 */
async function createPr(root, remote, options) {
  const { head, base, title, body } = options
  const attempts = []

  if (remote.kind === 'github') {
    if ((await tryExec(root, 'gh', ['--version'], 15_000)).ok) {
      const auth = await tryExec(root, 'gh', ['auth', 'status'], 20_000)
      if (auth.ok) {
        const created = await tryExec(root, 'gh', ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body], NETWORK_TIMEOUT_MS)
        if (created.ok) {
          return { ok: true, url: /https?:\/\/\S+/u.exec(created.stdout)?.[0] ?? '', method: 'gh', existing: false }
        }
        // 已存在同 head 的 PR 时 gh 会失败，改成列出那个。
        const listed = await tryExec(root, 'gh', ['pr', 'list', '--head', head, '--state', 'open', '--json', 'url'], 30_000)
        if (listed.ok) {
          try {
            const parsed = JSON.parse(listed.stdout)
            if (Array.isArray(parsed) && typeof parsed[0]?.url === 'string') {
              return { ok: true, url: parsed[0].url, method: 'gh', existing: true }
            }
          } catch {
            /* 解析不了就继续降级 */
          }
        }
        attempts.push(`gh pr create 失败：${clamp(created.stderr, 400)}`)
      } else {
        attempts.push('gh 已安装但未登录（`gh auth login`）')
      }
    } else {
      attempts.push('未安装 GitHub CLI（gh）')
    }
  }

  if (remote.kind === 'gitlab') {
    if ((await tryExec(root, 'glab', ['--version'], 15_000)).ok) {
      const created = await tryExec(
        root,
        'glab',
        ['mr', 'create', '--source-branch', head, '--target-branch', base, '--title', title, '--description', body, '--yes'],
        NETWORK_TIMEOUT_MS,
      )
      if (created.ok) {
        return { ok: true, url: /https?:\/\/\S+/u.exec(created.stdout)?.[0] ?? '', method: 'glab', existing: false }
      }
      attempts.push(`glab mr create 失败：${clamp(created.stderr, 400)}`)
    } else {
      attempts.push('未安装 GitLab CLI（glab）')
    }
  }

  const token = remote.kind === 'github' ? firstEnv(['GITHUB_TOKEN', 'GH_TOKEN']) : firstEnv(['GITLAB_TOKEN', 'GLAB_TOKEN'])
  if (token !== '') {
    const viaApi = await createViaApi(remote, token, head, base, title, body)
    if (viaApi.ok) return viaApi
    attempts.push(`REST API 失败：${viaApi.error ?? '未知错误'}`)
  } else {
    attempts.push(remote.kind === 'github' ? '未设置 GITHUB_TOKEN / GH_TOKEN' : '未设置 GITLAB_TOKEN')
  }

  return {
    ok: false,
    url: compareUrl(remote, base, head, title, body),
    method: 'link',
    attempts,
    error: attempts.join('；'),
  }
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

/** 取会话当前工作目录（与官方工具同源，改了 cd 也跟着走）。 */
async function workingDirectoryOf(ctx, agent, signal) {
  const service = ctx.get('workingDirectory')
  if (service !== undefined && service !== null && typeof service.ensure === 'function' && agent !== undefined) {
    try {
      return await service.ensure(agent, signal)
    } catch {
      /* 目录被删了就退回 header 记录的原始目录 */
    }
  }
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/**
 * 参数里的每个 token 是否都是「仓库内已存在的路径」。
 *
 * 全中才当路径用（决定 `git add` 的范围）；有一个不像路径就整串当说明文字。
 * @param cwd - 用户当前所在目录（相对路径按它解析）。
 * @param input - 用户的原始输入。
 * @returns 仓库内相对路径数组；任一 token 不是仓库内路径就返回空数组。
 */
async function existingPaths(cwd, input) {
  const tokens = input.split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return []
  const paths = []
  for (const token of tokens) {
    const repoPath = await repoPathFrom(cwd, token)
    if (repoPath === null) return []
    paths.push(repoPath)
  }
  return paths
}

/** `git commit -F -`：提交信息走 stdin，免去引号与换行的转义地狱。 */
function gitCommit(root, message) {
  return new Promise((settle) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', 'commit', '-F', '-'],
      {
        cwd: root,
        timeout: WRITE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_PAGER: 'cat', GIT_EDITOR: 'true' },
      },
      (error, stdout, stderr) => {
        settle({ ok: error === null, stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' })
      },
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(message.endsWith('\n') ? message : `${message}\n`)
  })
}

/** 判断文本里有没有 pre-commit 一类钩子失败的特征。 */
function looksLikeHookFailure(text) {
  return /pre-commit|husky|lint-?staged|hook/i.test(text)
}

/**
 * 一次完整的提交：检查 → 扫描 → 暂存 → 生成信息 → commit。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 * @param invocation - 命令调用（含 agent 与 signal）。
 * @param rawInput - 用户输入（路径范围或说明文字）。
 * @returns {kind, text} 命令结果。
 */
async function runCommit(ctx, config, invocation, rawInput) {
  const agent = invocation.agent
  const cwd = await workingDirectoryOf(ctx, agent, invocation.signal)
  if (cwd === null) return { kind: 'error', text: '读不到当前会话的工作目录，无法提交。' }
  const repo = await repoOf(cwd)
  if (repo === null) return { kind: 'error', text: `当前目录不是 Git 仓库：${cwd}` }

  const branch = await currentBranch(repo.root)
  if (branch === '') return { kind: 'error', text: '当前处于 detached HEAD，请先切换到一个分支再提交。' }

  const before = await statusOf(repo.root)
  if (before.length === 0) return { kind: 'success', text: `没有可提交的改动（${branch} 的工作区是干净的）。` }

  // 参数既可能是路径范围，也可能是提交说明——是仓库内已存在的路径就只暂存它。
  const paths = await existingPaths(cwd, rawInput)
  const hint = paths.length > 0 ? '' : rawInput.trim()

  // 先扫描再动索引：命中时一个字节都不改，用户已有的暂存也不会被连带清掉。
  const hits = await scanBeforeStage(repo.root, before)
  if (hits.length > 0) {
    const detail = hits.slice(0, 20).map((hit) => `  ${hit.path}  (${hit.reason})`).join('\n')
    return {
      kind: 'error',
      text: [
        '安全审查命中，这次提交已取消（暂存区没有被改动）。请先处理这些内容：',
        '',
        detail,
        hits.length > 20 ? `  …另有 ${hits.length - 20} 处` : '',
        '',
        '确认要提交其中某个文件时，请显式指出路径（注意：显式提交仍会做密钥内容检查）：',
        `  /commit ${hits[0].path}`,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  const addResult = await git(repo.root, paths.length > 0 ? ['add', '--', ...paths] : ['add', '-A'], { timeout: WRITE_TIMEOUT_MS })
  if (!addResult.ok) return { kind: 'error', text: `暂存失败：\n${clamp(addResult.stderr || addResult.stdout, 2_000)}` }

  const after = await statusOf(repo.root)
  const stagedEntries = after.filter((entry) => entry.staged)
  if (stagedEntries.length === 0) {
    return { kind: 'error', text: '暂存后没有任何内容可提交（改动可能都被 .gitignore 忽略了）。' }
  }

  const context = await changeContext(repo.root, 'staged')
  const history = await recentCommits(repo.root)
  const route = resolveCopyRoute(ctx, config, agent)
  let message
  let authored = false
  if (route !== null) {
    const prompt = [
      `仓库：${repo.root}`,
      `分支：${branch}`,
      '',
      '最近提交（用来学习格式与语言）：',
      history.length > 0 ? history.map((line) => `- ${line}`).join('\n') : '（这是第一个提交）',
      '',
      '将要提交的改动统计：',
      context.stat || '（无统计，可能只有新增/删除文件）',
      '',
      '改动文件：',
      context.files.join('\n') || '（无）',
      '',
      '改动内容（可能被截断）：',
      context.diff || '（没有文本差异）',
      ...(hint === '' ? [] : ['', `用户的补充说明：${hint}`]),
    ].join('\n')
    const answer = await askModel(ctx, route, COMMIT_SYSTEM, prompt, invocation.signal)
    if (answer !== null) {
      message = clampChars(answer.replace(/^```[a-z]*\n?/iu, '').replace(/```$/u, '').trim(), 4_000)
      authored = true
    }
  }
  if (message === undefined || message.trim() === '') {
    message = fallbackSubject(stagedEntries, hint)
    authored = false
  }

  const committed = await gitCommit(repo.root, message)
  if (!committed.ok) {
    const detail = committed.stderr || committed.stdout
    return {
      kind: 'error',
      text: [
        '提交失败：',
        clamp(detail, 3_000),
        '',
        looksLikeHookFailure(detail) ? '（看起来是 git 钩子失败。修好问题后重试；本插件不会用 --no-verify 跳过它。）' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  const head = await git(repo.root, ['log', '-1', '--pretty=format:%h'])
  const shortHash = head.ok ? head.stdout.trim() : ''
  const remaining = await statusOf(repo.root)
  return {
    kind: 'success',
    text: [
      `已在 ${branch} 上提交 ${shortHash}`,
      '',
      message
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
      '',
      `文件数：${stagedEntries.length}${remaining.length > 0 ? `，仍有 ${remaining.length} 个文件未提交` : '，工作区已干净'}`,
      authored ? '提交信息由模型生成。' : '未调用模型（或调用失败），提交信息由规则生成；建议用 `git commit --amend` 改成你想要的措辞。',
      '本次只做了本地提交，尚未推送。接着执行 /create-pr 才会推送并建 PR。',
    ].join('\n'),
  }
}

/** 解析 `/create-pr` 的参数：首个 token 是真远端分支就当 base，其余都算说明。 */
async function parsePrArgs(root, remoteName, rawInput) {
  const input = rawInput.trim()
  if (input === '') return { base: '', hint: '' }
  const [first, ...rest] = input.split(/\s+/u)
  if (first !== undefined && first !== '' && (await remoteBranchExists(root, first, remoteName))) {
    return { base: first, hint: rest.join(' ').trim() }
  }
  return { base: '', hint: input }
}

/** 推送当前分支（绝不用 --force）。 */
async function pushBranch(root, branch, remoteName) {
  const upstream = await hasUpstream(root)
  const args = upstream ? ['push', remoteName, branch] : ['push', '-u', remoteName, branch]
  const result = await git(root, args, { timeout: NETWORK_TIMEOUT_MS })
  if (result.ok) return { ok: true, message: `${result.stdout}${result.stderr}` }
  return { ok: false, message: clamp(result.stderr || result.stdout, 2_000) }
}

/** 生成 PR 标题与正文；模型不可用时用提交主题兜底。 */
async function buildPrCopy(ctx, config, agent, signal, root, options) {
  const { remoteName, base, branch, ahead, hint } = options
  const stat = await git(root, ['diff', `${remoteName}/${base}...HEAD`, '--stat'])
  const diff = await git(root, ['diff', `${remoteName}/${base}...HEAD`])
  const template = readPrTemplate(root)
  const route = resolveCopyRoute(ctx, config, agent)
  if (route !== null) {
    const prompt = [
      `分支：${branch} → ${base}`,
      ...(hint === '' ? [] : [`用户的补充说明：${hint}`]),
      '',
      '本分支的提交：',
      ahead.map((line) => `- ${line}`).join('\n'),
      '',
      '改动统计：',
      stat.ok ? clamp(stat.stdout, 6_000) : '（无）',
      ...(template === '' ? [] : ['', '仓库自带的 PR 模板（沿用它的章节结构）：', clamp(template, 4_000)]),
      '',
      '改动内容（可能被截断）：',
      diff.ok ? clamp(diff.stdout, MAX_PROMPT_DIFF) : '（无）',
    ].join('\n')
    const parsed = parsePrCopy(await askModel(ctx, route, PR_SYSTEM, prompt, signal))
    if (parsed !== null) return { ...parsed, authored: true }
  }
  const stripped = ahead.map((line) => line.replace(/^[0-9a-f]{7,}\s+/u, ''))
  const title = clampChars(hint !== '' ? hint : (stripped[0] ?? `${branch} → ${base}`), MAX_SUBJECT_CHARS)
  const body = ['## 变更内容', ...(stripped.length > 0 ? stripped.map((line) => `- ${line}`) : [`- ${title}`]), '', '## 验证', '- 未运行自动化测试'].join('\n')
  return { title, body, authored: false }
}

/** 仓库里的 PR 模板（GitHub 与 GitLab 的命名都认）。 */
function readPrTemplate(root) {
  const candidates = [
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/pull_request_template.md',
    'PULL_REQUEST_TEMPLATE.md',
    'pull_request_template.md',
    'docs/PULL_REQUEST_TEMPLATE.md',
    '.gitlab/merge_request_templates/Default.md',
  ]
  for (const relativePath of candidates) {
    const full = join(root, relativePath)
    try {
      if (existsSync(full) && statSync(full).size <= 64 * 1024) return readFileSync(full, 'utf8')
    } catch {
      /* 读不了就当没有模板 */
    }
  }
  return ''
}

/** 创建方式的标识 → 给用户看的说明。 */
function describeMethod(method) {
  switch (method) {
    case 'gh':
      return 'GitHub CLI（gh pr create）'
    case 'glab':
      return 'GitLab CLI（glab mr create）'
    case 'api':
      return 'REST API（环境变量里的 token）'
    default:
      return '网页链接'
  }
}

/**
 * 推送 + 建 PR。
 * @returns {kind, text}
 */
async function runCreatePr(ctx, config, invocation, rawInput) {
  const agent = invocation.agent
  const cwd = await workingDirectoryOf(ctx, agent, invocation.signal)
  if (cwd === null) return { kind: 'error', text: '读不到当前会话的工作目录，无法创建 PR。' }
  const repo = await repoOf(cwd)
  if (repo === null) return { kind: 'error', text: `当前目录不是 Git 仓库：${cwd}` }

  const origin = await originUrl(repo.root)
  if (origin.url === '') return { kind: 'error', text: '这个仓库没有配置任何远端。先执行 `git remote add origin <url>`。' }
  const remote = parseRemote(origin.url)
  if (remote === null) return { kind: 'error', text: `认不出远端地址：${origin.url}` }

  const branch = await currentBranch(repo.root)
  if (branch === '') return { kind: 'error', text: '当前处于 detached HEAD，请先切换到一个分支。' }

  const parsed = await parsePrArgs(repo.root, origin.name, rawInput)
  const base = parsed.base !== '' ? parsed.base : await defaultBase(repo.root, origin.name)

  if (branch === base) {
    return {
      kind: 'error',
      text: `当前就在目标分支 ${base} 上，没有东西可以开 PR。先建一个特性分支（例如 \`git switch -c feat/xxx\`）再执行 /create-pr。`,
    }
  }
  if (!(await remoteBranchExists(repo.root, base, origin.name))) {
    return { kind: 'error', text: `远端不存在目标分支 ${origin.name}/${base}。用 /create-pr <分支名> 指定一个真实存在的分支。` }
  }

  const pending = await statusOf(repo.root)
  if (pending.length > 0) {
    return {
      kind: 'error',
      text: [
        `工作区还有 ${pending.length} 个文件没提交。带着它们建 PR，会让人以为 PR 里包含这些改动。`,
        '先执行 /commit 提交，或者用 /commit-pr 一步完成。',
      ].join('\n'),
    }
  }

  const ahead = await commitsAhead(repo.root, base, origin.name)
  if (ahead.length === 0) return { kind: 'error', text: `当前分支没有领先 ${base} 的提交，没有内容可以开 PR。` }

  const pushed = await pushBranch(repo.root, branch, origin.name)
  if (!pushed.ok) return { kind: 'error', text: `推送失败（不会用 --force 覆盖远端）：\n${pushed.message}` }

  // 本地路径形式的远端能推，但没有任何 PR 平台可调：别假装去建，直接说清楚。
  if (remote.kind === 'local') {
    return {
      kind: 'success',
      text: [
        '分支已推送。',
        '',
        `但 origin 指向的是本地路径（${remote.repo}），不是 GitHub / GitLab，没有可以创建 PR 的平台。`,
        '把 origin 换成真实的远端地址后再执行 /create-pr。',
      ].join('\n'),
    }
  }

  const copy = await buildPrCopy(ctx, config, agent, invocation.signal, repo.root, {
    remoteName: origin.name,
    base,
    branch,
    ahead,
    hint: parsed.hint,
  })
  const created = await createPr(repo.root, remote, { head: branch, base, title: copy.title, body: copy.body, root: repo.root })

  if (created.ok) {
    return {
      kind: 'success',
      text: [
        created.existing ? '已存在同分支的 PR，直接给出链接：' : '已创建 PR：',
        `  ${created.url}`,
        '',
        `  ${branch} → ${base}`,
        `  标题：${copy.title}`,
        `  创建方式：${describeMethod(created.method)}`,
        `  ${copy.authored ? '标题与正文由模型生成。' : '标题与正文由规则生成（未调用模型）。'}`,
      ].join('\n'),
    }
  }

  // 兜底：链接一定可用。不假装成功，把「你只需要点一下」和失败原因都说清楚。
  return {
    kind: 'success',
    text: [
      '分支已推送，但没能自动创建 PR。用下面的链接在网页上点一下就完成了：',
      '',
      `  ${created.url}`,
      '',
      `  ${branch} → ${base}`,
      `  标题建议：${copy.title}`,
      '',
      '自动创建失败的原因：',
      `  ${created.error}`,
      '',
      remote.kind === 'github'
        ? '想以后自动创建：安装并登录 GitHub CLI（winget install --id GitHub.cli，然后 gh auth login），或设置 GITHUB_TOKEN 环境变量。'
        : remote.kind === 'gitlab'
          ? '想以后自动创建：安装并登录 GitLab CLI（glab auth login），或设置 GITLAB_TOKEN 环境变量。'
          : '这个代码托管平台没有内置的自动创建通道，请用上面的链接手动创建。',
    ].join('\n'),
  }
}

/**
 * `/commit-pr`：先提交（有改动时），再推送建 PR。
 *
 * 参数**只给 PR 用**（目标分支与标题提示）。提交阶段固定 `git add -A`：
 * 一个参数同时表达「提交哪些路径」和「PR 目标分支」只会让人猜，
 * 想要限定提交范围就用 /commit <路径> 再 /create-pr。
 */
async function runCommitPr(ctx, config, invocation) {
  const cwd = await workingDirectoryOf(ctx, invocation.agent, invocation.signal)
  const repo = cwd === null ? null : await repoOf(cwd)
  const pending = repo === null ? [] : await statusOf(repo.root)
  const commitResult = pending.length > 0 ? await runCommit(ctx, config, invocation, '') : null
  if (commitResult !== null && commitResult.kind === 'error') {
    // 提交失败就别往下走：把半成品推上去只会制造更乱的状态。
    return commitResult
  }
  const prResult = await runCreatePr(ctx, config, invocation, invocation.rawInput ?? '')
  if (commitResult === null) return prResult
  return { kind: prResult.kind, text: `${commitResult.text}\n\n${'─'.repeat(24)}\n\n${prResult.text}` }
}
/** 三个命令的定义。 */
function definitions(ctx, config) {
  const run = (impl) => async (invocation) => {
    try {
      return await impl(invocation.rawInput ?? '', invocation)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        ctx.logger?.warn?.(`[git-pr] ${message}`)
      } catch {
        /* 日志失败不影响把错误报给用户 */
      }
      return { kind: 'error', text: `执行失败：${message}` }
    }
  }
  return [
    {
      name: 'commit',
      description: '审查改动并生成符合仓库风格的提交信息，完成本地提交（不推送）',
      input: { hint: '[可选的路径范围（如 src/）或提交说明补充]' },
      handler: run((rawInput, invocation) => runCommit(ctx, config, invocation, rawInput)),
    },
    {
      name: 'create-pr',
      description: '推送当前分支并创建 Pull Request / Merge Request，按远端自动选择 GitHub 或 GitLab',
      input: { hint: '[目标分支] [可选的标题或说明补充]' },
      handler: run((rawInput, invocation) => runCreatePr(ctx, config, invocation, rawInput)),
    },
    {
      name: 'commit-pr',
      description: '一次完成提交、推送和创建 PR/MR',
      input: { hint: '[目标分支] [可选的标题或说明补充]' },
      handler: run((rawInput, invocation) => runCommitPr(ctx, config, invocation, rawInput)),
    },
  ]
}

/** patch 里的 config 是裸 JSON（本插件不导出 Config schema），这里手动兜默认值。 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const provider = typeof source.provider === 'string' ? source.provider.trim() : ''
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  const paired = provider !== '' && model !== ''
  return {
    // provider/model 必须成对出现：只给一个等于没给（否则会去请求一个不存在的路由）。
    provider: paired ? provider : '',
    model: paired ? model : '',
    registerTool: source.registerTool !== false,
  }
}

/**
 * 安装 Git 提交与 PR 命令。
 * @param ctx - 拥有这些注册的插件上下文。
 * @param rawConfig - patch 行里的 config（可选：provider/model/registerTool）。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[git-pr] ${message}`)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  for (const definition of definitions(ctx, config)) {
    ctx.effect(() => ctx.commands.register(definition), `git-pr: /${definition.name}`)
  }

  // 等价的工具形态：用户说「帮我提交并开个 PR」时，模型自己也能调。
  const tools = ctx.get('tools')
  if (config.registerTool && tools !== undefined && tools !== null && typeof tools.register === 'function') {
    try {
      ctx.effect(
        () =>
          tools.register({
            name: 'git_commit_pr',
            description:
              'Commit the current workspace changes and/or push the current branch to open a Pull Request or Merge Request. Writes the commit message and PR title/body automatically. Use action "commit" for a local commit only, "create-pr" to push and open a PR, or "commit-pr" for both. Never force-pushes.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: {
                  type: 'string',
                  enum: ['commit', 'create-pr', 'commit-pr'],
                  description: 'Which operation to run.',
                },
                input: {
                  type: 'string',
                  description: 'Optional extra hint: a path scope for commit, or "[target branch] [title hint]" for PR creation.',
                },
              },
              required: ['action'],
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean', description: 'Whether the operation completed successfully.' },
                  text: { type: 'string', description: 'Human-readable report to relay to the user.' },
                },
                required: ['ok', 'text'],
              },
              render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }],
            },
            async execute(args, exec) {
              if (exec.agent === undefined) throw new Error('git_commit_pr requires an agent Session')
              const invocation = {
                agent: exec.agent,
                signal: exec.signal,
                rawInput: typeof args?.input === 'string' ? args.input : '',
              }
              const result =
                args.action === 'commit'
                  ? await runCommit(ctx, config, invocation, invocation.rawInput)
                  : args.action === 'create-pr'
                    ? await runCreatePr(ctx, config, invocation, invocation.rawInput)
                    : await runCommitPr(ctx, config, invocation)
              return { ok: result.kind === 'success', text: result.text }
            },
          }),
        'git-pr: git_commit_pr tool',
      )
    } catch (error) {
      log('warn', `注册工具失败，斜杠命令不受影响：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 启动自检：git 在不在，一眼可见；不在也不拦住其它插件。
  void (async () => {
    const version = await git(process.cwd(), ['--version'])
    if (!version.ok) {
      log('error', '找不到可用的 git，/commit、/create-pr、/commit-pr 都会失败。')
      return
    }
    log(
      'info',
      `已启用，${version.stdout.trim()}（build ${HOST_BUILD}；文案模型：${config.model === '' ? '跟随会话最近一次请求的路由' : `${config.provider}/${config.model}`}）`,
    )
  })()
}

/** 默认 DSH 主目录（与其它插件保持一致，便于将来共享配置）。 */
export const __defaultHome =
  typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')

// 供 smoke 复用：这些是纯函数（或只依赖 git CLI），不需要真起宿主就能验证。
export const __internals = {
  HOST_BUILD,
  SECRET_FILE_PATTERNS,
  SECRET_VALUE_PATTERNS,
  git,
  repoOf,
  currentBranch,
  parseStatus,
  statusOf,
  originUrl,
  parseRemote,
  defaultBase,
  remoteBranchExists,
  commitsAhead,
  recentCommits,
  changeContext,
  isSecretPath,
  secretKinds,
  scanBeforeStage,
  fallbackSubject,
  clampChars,
  unwrap,
  parsePrCopy,
  compareUrl,
  createPr,
  createViaApi,
  apiBaseOf,
  runCommit,
  runCreatePr,
  runCommitPr,
  parsePrArgs,
  existingPaths,
  readPrTemplate,
  buildPrCopy,
  resolveCopyRoute,
  assembledText,
  normalizeConfig,
  definitions,
  describeMethod,
}
