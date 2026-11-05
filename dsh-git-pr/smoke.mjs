/**
 * dsh-git-pr 的自检脚本。
 *
 * 与另外几个插件一样：不启动浏览器、不连 DSH，用极简替身在 Node 里把真实的
 * 注册契约、纯函数和 **真 git 流程** 各跑一遍。
 *
 *   - Host 侧真的建临时仓库（本地 bare 仓库当远端），跑 /commit 与失败的
 *     /create-pr 分支，断言工作区、提交内容、错误文案都符合预期；
 *   - 安全扫描用真实文件验证：凭据文件、密钥字面量必须拦住，正常代码不能误伤；
 *   - Client 半不存在（这个插件是纯 Host），所以额外断言「没有任何前端文件」；
 *   - 用 `execFile` 而不是开 shell，天然覆盖了「参数里有空格/引号」的情形。
 *
 * 用法：node dsh-git-pr\smoke.mjs
 * 退出码 0 且打印 ALL PASS 才算过。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
let failures = 0
let checks = 0

/** 一条断言。 */
function check(ok, label) {
  checks += 1
  if (ok) {
    console.log(`  PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${label}`)
}

/** 分组标题。 */
function group(title) {
  console.log(`\n${title}`)
}

/** 跑一条命令并收集结果（不抛异常）。 */
function run(cwd, command, args) {
  return new Promise((settle) => {
    execFile(command, args, { cwd, timeout: 120_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      settle({ ok: error === null, code: error === null ? 0 : (error.code ?? 1), stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/** 必须成功的 git 命令，失败就直接抛（说明测试环境坏了，不是插件坏了）。 */
async function mustGit(cwd, args) {
  const result = await run(cwd, 'git', args)
  if (!result.ok) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
  return result.stdout
}

/** 假 ctx：只提供 apply 真正用到的那几个入口。 */
function makeCtx({ tools } = {}) {
  const commands = []
  const disposers = []
  const logs = []
  return {
    commands: {
      register(definition) {
        if (commands.some((entry) => entry.name === definition.name)) throw new Error(`duplicate command ${definition.name}`)
        commands.push(definition)
        return () => {}
      },
    },
    registry: { commands },
    effect(fn, label) {
      const dispose = fn()
      disposers.push({ label, dispose })
      return dispose
    },
    get(name) {
      if (name === 'tools') return tools
      return undefined
    },
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    logs,
    disposers,
  }
}

// ---------------------------------------------------------------------------
// 1. 包与 manifest 契约
// ---------------------------------------------------------------------------
group('包契约')

const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
const patch = readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8')
const zh = JSON.parse(readFileSync(join(HERE, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(HERE, 'locale', 'en.json'), 'utf8'))
const icon = readFileSync(join(HERE, 'icon.svg'), 'utf8')

check(pkg.name === '@local/dsh-git-pr', 'package.json name 为 @local/dsh-git-pr')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', '声明了 dsh.bundle.patch')
check(patch.includes("id: git-pr") && patch.includes("name: '@local/dsh-git-pr'"), 'patch 里插入了 git-pr 行')
check(pkg.files.includes('index.js') && pkg.files.includes('cordis.patch.yml'), 'files 覆盖运行所需文件')
check(pkg.exports['./locale/*.json'] === './locale/*.json', 'exports 暴露 locale')
check(typeof zh.meta?.title === 'string' && zh.meta.title !== '', 'zh.json 有标题')
check(typeof en.meta?.title === 'string' && en.meta.title !== '', 'en.json 有标题')
check(typeof zh.meta.description === 'string' && typeof en.meta.description === 'string', '两种语言都有描述')
check(icon.includes('role="img"') && icon.includes('aria-label'), 'icon.svg 带无障碍属性')

// 纯 Host 插件：多带一个 client.js 反而会被 dsh.client 声明发现，容易误导。
let hasClient = true
try {
  readFileSync(join(HERE, 'client.js'), 'utf8')
} catch {
  hasClient = false
}
check(!hasClient, '这是纯 Host 插件，没有 client.js')
check(pkg.dsh?.client === undefined, 'package.json 没有声明 dsh.client')

// ---------------------------------------------------------------------------
// 2. 模块形状与命令注册
// ---------------------------------------------------------------------------
group('注册契约')

const mod = await import(new URL('./index.js', import.meta.url).href)
check(mod.name === 'git-pr', 'name 导出为 git-pr（等于 patch 行 id）')
check(Array.isArray(mod.inject) && mod.inject.includes('commands'), 'inject 只硬依赖 commands')
check(typeof mod.apply === 'function', '导出 apply')
check(typeof mod.normalizeConfig === 'function', '导出 normalizeConfig')

const ctx = makeCtx({ tools: { register: () => () => {} } })
mod.apply(ctx, undefined)
const names = ctx.registry.commands.map((definition) => definition.name).sort()
check(names.join(',') === 'commit,commit-pr,create-pr', '/commit、/commit-pr、/create-pr 都已注册')
for (const definition of ctx.registry.commands) {
  check(typeof definition.description === 'string' && definition.description.trim() !== '', `/${definition.name} 有描述`)
  check(typeof definition.input?.hint === 'string' && definition.input.hint.trim() !== '', `/${definition.name} 有 input.hint`)
  check(typeof definition.handler === 'function', `/${definition.name} 有 handler`)
}
check(/^[a-z][a-z0-9_-]*$/u.test('create-pr'), 'create-pr 符合宿主命令名规则（只允许小写与中划线）')
check(ctx.disposers.length >= 3, '注册都走了 ctx.effect（可被卸载）')

// ---------------------------------------------------------------------------
// 3. 配置清洗
// ---------------------------------------------------------------------------
group('配置清洗')

const cfgDefault = mod.normalizeConfig(undefined)
check(cfgDefault.provider === '' && cfgDefault.model === '', '无配置时留空（跟随会话路由）')
check(cfgDefault.registerTool === true, '默认注册工具')
const cfgHalf = mod.normalizeConfig({ provider: 'x' })
check(cfgHalf.provider === '' && cfgHalf.model === '', '只给 provider 视为没给（必须成对）')
const cfgFull = mod.normalizeConfig({ provider: ' p ', model: ' m ', registerTool: false })
check(cfgFull.provider === 'p' && cfgFull.model === 'm', '成对的 provider/model 会去空白并生效')
check(cfgFull.registerTool === false, 'registerTool: false 被保留')

// ---------------------------------------------------------------------------
// 4. 纯函数
// ---------------------------------------------------------------------------
group('纯函数')

const { parseRemote, parseStatus, parsePrCopy, compareUrl, fallbackSubject, clampChars, unwrap, secretKinds, isSecretPath } = mod.__internals

const github = parseRemote('git@github.com:ffffk2/dsh-plugins.git')
check(github?.kind === 'github' && github.owner === 'ffffk2' && github.repo === 'dsh-plugins', '解析 scp 风格 GitHub 地址')
check(github?.webBase === 'https://github.com/ffffk2/dsh-plugins', 'scp 风格也给出 https 网页地址')

const gitlab = parseRemote('https://gitlab.example.com/group/sub/repo.git')
check(gitlab?.kind === 'gitlab', '识别 GitLab')
check(gitlab?.owner === 'group/sub', '自建 GitLab 的多层命名空间保留下来')

const ssh = parseRemote('ssh://git@gitlab.example.com:2222/group/repo.git')
check(ssh?.kind === 'gitlab' && ssh.repo === 'repo', '解析 ssh:// 且带端口的地址')

check(parseRemote('D:\\code\\plugins\\foo')?.kind === 'local', 'Windows 盘符远端识别为本地路径')
check(parseRemote('../remote.git')?.kind === 'local', '相对路径远端识别为本地路径')
check(parseRemote('not a url') === null, '非 URL 返回 null')
check(parseRemote('https://github.com/only-owner') === null, '缺少仓库名返回 null')

const statusRaw = [' M a.js', 'A  b.js', '?? c.js', 'R  d.js', 'e.js', ''].join('\0')
const parsedStatus = parseStatus(statusRaw)
check(parsedStatus.length === 4, 'porcelain -z 解析出 4 个条目（重命名的原路径被跳过）')
check(parsedStatus[0].path === 'a.js' && parsedStatus[0].staged === false, '未暂存条目 staged=false')
check(parsedStatus[1].path === 'b.js' && parsedStatus[1].staged === true, '已暂存条目 staged=true')
check(parsedStatus[2].untracked === true, '未跟踪条目被标记')
check(parsedStatus[3].path === 'd.js', '重命名只保留新路径')

const copy = parsePrCopy('TITLE: feat: 支持提交\nBODY:\n## 变更内容\n- 加了命令')
check(copy?.title === 'feat: 支持提交', '解析 TITLE')
check(copy?.body.includes('## 变更内容'), '解析 BODY')
check(parsePrCopy('') === null, '空输出解析为 null')
const noBody = parsePrCopy('TITLE: fix: 修一下')
check(noBody?.title === 'fix: 修一下', '只有标题时也能解析')
const noTitle = parsePrCopy('BODY:\n## 变更内容\n- x')
check(noTitle !== null && noTitle.title === '## 变更内容', '没有标题时用正文首行兜底')

const link = compareUrl(github, 'main', 'feat/x', '标题', '正文')
check(link.startsWith('https://github.com/ffffk2/dsh-plugins/compare/main...feat%2Fx?'), 'GitHub 生成 compare 链接')
check(link.includes('expand=1'), 'GitHub 链接带 expand=1')
const mrLink = compareUrl(gitlab, 'main', 'feat/x', '标题', '')
check(mrLink.includes('/-/merge_requests/new?'), 'GitLab 生成 MR 新建链接')
check(!mrLink.includes('body='), 'GitLab 链接不塞正文（它走 description 字段）')

check(clampChars('abcdef', 4).length === 4, 'clampChars 按码点截断')
check(clampChars('中文中文中文', 4) === '中文中…', '中文按码点截断不出现半个字')
check(clampChars('中文中文中文', 4) !== '中文中\uFFFD', '截断后没有替换字符')
check(unwrap('"hello"') === 'hello', 'unwrap 去掉包裹引号')
check(fallbackSubject([{ path: 'src/a.js', untracked: false }], '') .startsWith('更新 src'), '兜底主题行带变更类型与范围')
check(fallbackSubject([], '手写的说明') === '手写的说明', '兜底主题行优先用用户给的说明')

check(isSecretPath('.env') && isSecretPath('a/.env.local') && isSecretPath('keys/server.pem'), '凭据文件名被识别')
check(isSecretPath('id_rsa') && isSecretPath('config/.npmrc'), 'SSH 私钥与 npmrc 被识别')
check(!isSecretPath('src/environment.js'), 'environment.js 不被误判成 .env')
check(!isSecretPath('src/index.js'), '普通源码文件不命中')

check(secretKinds("const password = 'hunter2hunter2'").includes('secret-literal'), '识别硬编码密码')
check(secretKinds('token: process.env.GITHUB_TOKEN').length === 0, '引用环境变量不算密钥')
check(secretKinds("apiKey: '<REPLACE_ME>'").length === 0, '占位符不算密钥')
check(secretKinds('const key = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa"').includes('github-token'), '识别 GitHub token')
check(secretKinds("-----BEGIN RSA PRIVATE KEY-----").includes('private-key-block'), '识别私钥块')
check(secretKinds('const x = 1').length === 0, '普通代码不误伤')

// ---------------------------------------------------------------------------
// 5. 真 git 流程
// ---------------------------------------------------------------------------
group('真实仓库流程')

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-git-pr-'))
const repoDir = join(sandbox, 'repo')
const remoteDir = join(sandbox, 'remote.git')
let cleaned = false

try {
  await mustGit(sandbox, ['init', '-q', '--bare', '-b', 'main', remoteDir])
  await mustGit(sandbox, ['init', '-q', '-b', 'main', repoDir])
  await mustGit(repoDir, ['config', 'user.email', 'smoke@example.com'])
  await mustGit(repoDir, ['config', 'user.name', 'Smoke Test'])
  await mustGit(repoDir, ['config', 'commit.gpgsign', 'false'])
  await mustGit(repoDir, ['remote', 'add', 'origin', remoteDir])

  writeFileSync(join(repoDir, 'README.md'), '# demo\n')
  await mustGit(repoDir, ['add', '-A'])
  await mustGit(repoDir, ['commit', '-q', '-m', 'chore: 初始化仓库'])
  await mustGit(repoDir, ['push', '-q', '-u', 'origin', 'main'])

  const repo = await mod.__internals.repoOf(repoDir)
  check(repo?.root !== undefined && repo.root !== '', 'repoOf 认出仓库根')
  check((await mod.__internals.currentBranch(repoDir)) === 'main', 'currentBranch 读当前分支')
  check((await mod.__internals.remoteBranchExists(repoDir, 'main')) === true, '远端分支探测成功')
  check((await mod.__internals.defaultBase(repoDir)) === 'main', 'defaultBase 认 origin/HEAD')

  // 干净的仓库：/commit 不该造出空提交。
  const clean = await mod.__internals.runCommit(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, '')
  check(clean.kind === 'success' && clean.text.includes('没有可提交的改动'), '工作区干净时 /commit 不造空提交')

  // 有改动：/commit 应真的提交，并回填哈希。
  writeFileSync(join(repoDir, 'feature.js'), 'export const answer = 42\n')
  mkdirSync(join(repoDir, 'src'), { recursive: true })
  writeFileSync(join(repoDir, 'src/util.js'), 'export const twice = (n) => n * 2\n')
  const committed = await mod.__internals.runCommit(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, '')
  check(committed.kind === 'success', '/commit 成功')
  check(/已在 main 上提交 [0-9a-f]{7,}/u.test(committed.text), '回报里带短哈希')
  check(committed.text.includes('本地提交，尚未推送'), '明确说明只做了本地提交')
  const logAfter = await mustGit(repoDir, ['log', '-1', '--pretty=format:%s%n%b'])
  check(logAfter.trim() !== '', '确实产生了一条提交')
  check(!/Generated with|Co-authored-by/u.test(logAfter), '规则兜底的提交信息没有工具署名')
  const statusAfter = await mustGit(repoDir, ['status', '--porcelain'])
  check(statusAfter.trim() === '', '提交后工作区干净')

  // 路径范围：只暂存指定目录。
  writeFileSync(join(repoDir, 'src', 'more.js'), 'export const three = 3\n')
  writeFileSync(join(repoDir, 'other.js'), 'export const other = 1\n')
  const scoped = await mod.__internals.runCommit(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, 'src')
  check(scoped.kind === 'success', '带路径范围时 /commit 成功')
  const scopedFiles = await mustGit(repoDir, ['show', '--name-only', '--pretty=format:', 'HEAD'])
  check(scopedFiles.includes('src/more.js'), '指定范围内的文件进了提交')
  check(!scopedFiles.includes('other.js'), '范围外的文件没有被提交')
  const stillPending = await mustGit(repoDir, ['status', '--porcelain'])
  check(stillPending.includes('other.js'), '范围外的文件仍是未提交状态')

  // 安全扫描：凭据文件必须拦住，而且不能动暂存区。
  await mustGit(repoDir, ['add', 'other.js'])
  writeFileSync(join(repoDir, '.env'), 'SECRET=1\n')
  const blocked = await mod.__internals.runCommit(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, '')
  check(blocked.kind === 'error', '出现 .env 时 /commit 被拦住')
  check(blocked.text.includes('.env'), '错误信息点名了命中的文件')
  check(blocked.text.includes('credential-file'), '错误信息给出了命中原因')
  check(blocked.text.includes('/commit .env'), '错误信息给出继续的办法')
  const indexAfterBlock = await mustGit(repoDir, ['diff', '--cached', '--name-only'])
  check(indexAfterBlock.includes('other.js'), '被拦住时用户原有的暂存内容没被清掉')

  // 硬编码密钥：拦住。
  rmSync(join(repoDir, '.env'))
  writeFileSync(join(repoDir, 'config.js'), "export const password = 'hunter2hunter2'\n")
  const secretBlocked = await mod.__internals.runCommit(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, '')
  check(secretBlocked.kind === 'error', '硬编码密码时 /commit 被拦住')
  check(secretBlocked.text.includes('secret-literal'), '错误信息说明是密钥字面量')

  // 环境变量写法：不该误伤。
  writeFileSync(join(repoDir, 'config.js'), "export const password = process.env.DB_PASSWORD\n")
  const allowed = await mod.__internals.runCommit(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, '')
  check(allowed.kind === 'success', '读取环境变量的写法不会被误拦')

  // 推送与 PR 前置检查。
  await mustGit(repoDir, ['push', '-q', 'origin', 'main'])
  const onBase = await mod.__internals.runCreatePr(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, '')
  check(onBase.kind === 'error' && onBase.text.includes('就在目标分支'), '在 base 分支上时明确拒绝建 PR')

  await mustGit(repoDir, ['switch', '-q', '-c', 'feat/smoke'])
  writeFileSync(join(repoDir, 'feature2.js'), 'export const four = 4\n')
  await mod.__internals.runCommit(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, '')
  // feat/smoke 领先 main 一条提交，所以这里应该真的推送。远端是本地 bare 仓库，
  // 没有 PR 平台可调——必须明确说出来，而不是伪造一个 PR 链接。
  const localRemote = await mod.__internals.runCreatePr(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, '')
  check(localRemote.kind === 'success', '远端是本地路径时仍成功推送')
  check(localRemote.text.includes('本地路径'), '明确说明 origin 是本地路径')
  check(localRemote.text.includes('没有可以创建 PR 的平台'), '明确说明没有 PR 平台，而不是伪造链接')
  check(!/https?:\/\//u.test(localRemote.text), '不会给出打不开的假链接')
  const remoteBranches = await mustGit(remoteDir, ['branch', '--list', 'feat/smoke'])
  check(remoteBranches.includes('feat/smoke'), '分支确实推到了远端')
  check(!localRemote.text.includes('--force'), '汇报里不会建议 force push')

  // 把 origin 换成一个能解析出平台、但连不上的地址：走降级链，最终给链接。
  await mustGit(repoDir, ['remote', 'set-url', 'origin', 'https://github.com/smoke-test/nonexistent-repo.git'])
  await mustGit(repoDir, ['update-ref', `refs/remotes/origin/main`, 'refs/heads/main'])
  writeFileSync(join(repoDir, 'feature3.js'), 'export const five = 5\n')
  await mod.__internals.runCommit(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, '')
  const linkFallback = await mod.__internals.runCreatePr(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, '')
  // 推送会因为凭据/网络失败（不留凭据、不弹交互），这一步必须是「如实失败」。
  check(linkFallback.kind === 'error', '推不上去时如实报错而不是报成功')
  check(linkFallback.text.includes('推送失败'), '错误信息指明卡在推送这一步')
  check(!/https?:\/\/github\.com\/smoke-test/u.test(linkFallback.text) || linkFallback.text.includes('推送失败'), '不会在推送失败时假装 PR 建好了')

  // 工作区有未提交改动时不允许建 PR（否则 PR 内容与描述不一致）。
  await mustGit(repoDir, ['remote', 'set-url', 'origin', remoteDir])
  writeFileSync(join(repoDir, 'dirty.js'), 'export const dirty = true\n')
  const dirty = await mod.__internals.runCreatePr(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  }, '')
  check(dirty.kind === 'error' && dirty.text.includes('没提交'), '工作区有改动时拒绝建 PR')

  // /commit-pr：一步走完。
  const both = await mod.__internals.runCommitPr(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: repoDir } } },
    signal: new AbortController().signal,
  })
  check(both.kind === 'success', '/commit-pr 成功')
  check(both.text.includes('已在 feat/smoke 上提交') || both.text.includes('提交'), '/commit-pr 汇报里包含提交结果')
  check(both.text.includes('─'.repeat(24)), '/commit-pr 把提交与 PR 两段结果分开')

  // 非仓库目录：给明确错误而不是崩。
  const notRepo = mkdtempSync(join(sandbox, 'plain-'))
  const plain = await mod.__internals.runCommit(ctx, mod.normalizeConfig(undefined), {
    agent: { session: { header: { cwd: notRepo } } },
    signal: new AbortController().signal,
  }, '')
  check(plain.kind === 'error' && plain.text.includes('不是 Git 仓库'), '非仓库目录给出明确错误')

  // handler 捕获异常：绝不让宿主看到未处理的 rejection。
  const definition = ctx.registry.commands.find((entry) => entry.name === 'commit')
  const thrown = await definition.handler({
    agent: undefined,
    rawInput: '',
    signal: new AbortController().signal,
    commandId: 'x',
    attachments: [],
  })
  check(thrown.kind === 'error', 'handler 把异常转成 error 结果（不会抛到宿主）')
} finally {
  if (!cleaned) {
    cleaned = true
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 6. 工具形态
// ---------------------------------------------------------------------------
group('工具形态')

const registered = []
const toolCtx = makeCtx({ tools: { register: (definition) => { registered.push(definition); return () => {} } } })
mod.apply(toolCtx, undefined)
check(registered.length === 1, '注册了一个工具')
const tool = registered[0]
check(tool.name === 'git_commit_pr', '工具名是 git_commit_pr')
check(typeof tool.execute === 'function', '工具有 execute')
check(tool.parameters?.required?.includes('action'), 'action 是必填参数')
check(Array.isArray(tool.parameters?.properties?.action?.enum) && tool.parameters.properties.action.enum.join(',') === 'commit,create-pr,commit-pr', 'action 枚举覆盖三种操作')
check(tool.output?.schema?.type === 'object', '输出 schema 是对象根（宿主强制要求）')
check(typeof tool.output?.render === 'function', '输出有 render（宿主强制要求）')

const noToolCtx = makeCtx({ tools: undefined })
let threw = false
try {
  mod.apply(noToolCtx, undefined)
} catch {
  threw = true
}
check(threw === false, '没有 tools 服务时 apply 不抛异常（工具是可选增强）')
check(noToolCtx.registry.commands.length === 3, '没有 tools 服务时命令照旧注册')

const disabledCtx = makeCtx({ tools: { register: () => () => {} } })
mod.apply(disabledCtx, { registerTool: false })
check(disabledCtx.registry.commands.length === 3, 'registerTool:false 时命令仍注册')

// ---------------------------------------------------------------------------
// 7. 代码风格约定（与仓库其它插件一致）
// ---------------------------------------------------------------------------
group('代码风格')

const source = readFileSync(join(HERE, 'index.js'), 'utf8')
check(!source.includes('\r\n'), 'index.js 是 LF 行尾')
check(!/\t/u.test(source), 'index.js 使用空格缩进（无制表符）')
const runtimeImports = [...source.matchAll(/^import .* from '([^']+)'/gmu)].map((match) => match[1])
check(runtimeImports.every((specifier) => specifier.startsWith('node:')), '运行时只依赖 node:* 内置模块')
check(runtimeImports.length > 0, '确实有 import（不是空文件）')
check(source.includes('execFile('), '用 execFile 调 git（数组传参，不经 shell）')
// 只认真正的子进程调用：正则字面量的 .exec() 与源码无关。
check(!/child_process[\s\S]{0,200}\bexec\(/u.test(source), '没有用 exec（避免 shell 拼接注入）')
check(!/^\s*exec\(/mu.test(source), '没有裸 exec( 调用')
// 文档里出现的 ``--force`` 是「本插件不用它」的说明，只断言真的没把它当参数发出去。
check(!/'--force'|"--force"|'--force-with-lease'|"--force-with-lease"/u.test(source), '没有任何地方把 --force 当参数传给 git')
check(!/'--no-verify'|"--no-verify"/u.test(source), '没有任何地方把 --no-verify 当参数传给 git')
check(source.includes('GIT_TERMINAL_PROMPT'), '禁用 git 的交互式凭据提示')

// 收尾
console.log(`\n共 ${checks} 项断言，失败 ${failures} 项`)
if (failures === 0) console.log('ALL PASS')
else {
  console.log('FAILED')
  process.exitCode = 1
}
