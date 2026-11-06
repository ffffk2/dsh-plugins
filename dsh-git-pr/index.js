/**
 * Git 提交与 PR —— Host 半（纯命令）。
 *
 * 三个斜杠命令，作用等同于你在输入框里把一段「提交代码 / 开个 PR」的要求发给 DSH：
 *
 *   /commit      提交当前改动（不推送）
 *   /create-pr   推送当前分支并建 PR/MR
 *   /commit-pr   提交 + 推送 + 建 PR 一次走完
 *
 * 为什么是「转交模型」而不是「插件里写死一套 git 流程」：
 *   - 这一批操作几乎每一步都依赖现场判断——有没有改动、在不在主干上、要不要新建分支、
 *     提交信息用什么语言、PR 目标分支是哪个、有没有 PR 模板、gh 能不能用。
 *     写死在代码里就会退化成「工作区干净 ⇒ 报错」「在主干上 ⇒ 报错」这种硬门槛，
 *     而用户真正想要的是「像我跟它说一句那样，让它自己看着办」。
 *   - 所以插件只做两件事：把**经过打磨的操作规程**（下面那几段文本）和**用户这次给的参数**
 *     拼成一条指令，通过 `agent.followup()` 排进会话；剩下的由模型用它能用的工具执行。
 *   - 规程本身仍然是确定性的：安全审查、不许 force、不许 --no-verify、提交信息跟随仓库风格、
 *     PR 正文不许编造测试结果——这些约束写进指令里，模型照着执行。
 *
 * 与 `/goal` 的机制一致：都是往会话里排一条 user 消息并唤醒驱动，命令本身立即返回。
 */
import { randomUUID } from 'node:crypto'

/** Cordis 插件名（必须等于 cordis.patch.yml 里的行 id）。 */
export const name = 'git-pr'
/** 只需要命令注册表。 */
export const inject = ['commands']

/**
 * 三个命令共用的硬性约定。
 *
 * 单独抽出来是因为它在三个场景里都要重复出现：宁可指令长一点，也不要让某条命令漏掉
 * 「不许 force」或「先扫描再 add」这类约束——漏掉一次就可能推上去一个密钥。
 */
const RULES = [
  '## 必须遵守的约定',
  '',
  '- 不要使用 `--force` / `--force-with-lease`，也不要 `--no-verify` 跳过钩子。',
  '- 不要修改 `.git/config`，不要写入任何凭据文件；token 只从环境变量读取，且绝不回显到输出里。',
  '- 提交之前先做安全审查（见各步骤），命中就停下并如实列出文件与原因，等用户决定。',
  '- 每一步都以**真实命令的输出**为准（例如先跑 `git status`、`git log`、`git remote -v` 看现场），',
  '  不要根据之前的印象假设状态；命令失败就如实报告，不要假装成功。',
  '- 用户可见的汇报用中文，简洁但把关键事实写全（哈希、分支、链接、失败原因）。',
].join('\n')

/** `/commit` 的操作规程。 */
function commitInstruction(rawInput) {
  const hint = rawInput.trim()
  return [
    '请在这个仓库里完成一次本地提交（不要推送）。',
    ...(hint === '' ? [] : ['', `用户这次给的说明或路径范围：\`${hint}\``]),
    '',
    '## 1. 确认环境',
    '- `git rev-parse --show-toplevel` 失败就停止，说明当前目录不是 Git 仓库。',
    '- `git branch --show-current` 为空说明处于 detached HEAD。这种情况不要直接停：',
    '  先看 `git status`，有改动就 `git switch -c <描述性的分支名>` 再继续。',
    '',
    '## 2. 收集上下文（可以并行执行）',
    '- `git status --short`、`git diff --stat`、`git diff`、`git diff --cached`',
    '- `git log --oneline -20`：用来学习本仓库提交信息的语言与格式；仓库还没有提交时这条会报错，忽略即可。',
    '',
    '## 3. 没有改动时',
    '如实说明「没有可提交的改动」并结束，不要创建空提交。',
    '',
    '## 4. 安全审查（必须在 `git add` 之前做）',
    '命中任意一项就停止，列出文件与原因，等用户决定；不要自作主张提交：',
    '- 凭据类文件：`.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`id_rsa*`、`credentials*`、`.npmrc`、`.netrc`',
    '- 新增行里出现真实密钥字面量（`password` / `secret` / `token` / `api_key` 后面跟着像密钥的值；',
    '  读取环境变量的写法、占位符不算）',
    '- 单个超过 5 MB 的文件（基本都是误提交的二进制）',
    '',
    '## 5. 暂存与提交',
    '- 默认 `git add -A`。如果用户给的参数是仓库内已存在的路径范围，就只 `git add -- <这些路径>`；',
    '  如果参数是说明文字而不是路径，仍用 `git add -A`，并把它作为写提交信息的提示。',
    '- 暂存后再次 `git status --short` 确认实际进入提交的内容。',
    '- 提交信息跟随最近 20 条的风格：历史用 Conventional Commits（`feat:` / `fix:` / `refactor:`…）就沿用；',
    '  历史是纯中文描述就用中文；两者都不明显时用 Conventional Commits，主题行可用中文。',
    '- 主题行不超过 72 个字符，动词开头，写清「做了什么」，不要写「修改了一些代码」这类空话；',
    '  只有需要解释原因、影响面或权衡时才写正文，正文每行不超过 72 字符。',
    '- 破坏性变更在主题行加 `!` 并在正文写 `BREAKING CHANGE:` 脚注。',
    '- 不要添加 `Generated with …` / `Co-authored-by` 之类的工具署名，除非用户明确要求。',
    '- 用 `git commit -F -` 或写临时文件的方式递提交信息，避免引号与换行的转义问题。',
    '- 钩子失败时：读错误信息，能修就修；修不了就原样报告并停止。',
    '',
    '## 6. 汇报',
    '- 短哈希、完整提交信息、涉及文件数、仍未提交的剩余内容。',
    '- 说明本次只做了本地提交、尚未推送；下一步可以执行 `/create-pr`。',
    '',
    RULES,
  ].join('\n')
}

/** `/create-pr` 的操作规程。 */
function createPrInstruction(rawInput) {
  const hint = rawInput.trim()
  return [
    '请把当前分支推送并创建 Pull Request / Merge Request。',
    ...(hint === '' ? [] : ['', `用户这次给的参数（可能是目标分支，也可能是标题或说明）：\`${hint}\``]),
    '',
    '## 1. 前置检查',
    '- 不是 Git 仓库就停止。',
    '- `git remote -v` 里没有 origin 就停止，提示先 `git remote add origin <url>`。',
    '- 从 origin 的 URL 判断平台：主机含 `github` → GitHub；含 `gitlab` → GitLab；其他按通用 Git 服务处理。',
    '  兼容 `git@host:owner/repo.git`、`ssh://…`、`https://…` 三种写法；自建 GitLab 的多层命名空间要保留完整。',
    '- detached HEAD 就先按 `/commit` 里的做法建分支。',
    '',
    '## 2. 确定目标分支',
    '- 用户给的参数如果是一个**真实存在**的远端分支（`git ls-remote --heads origin <参数>` 有输出），就用它作 base；',
    '  否则把参数当作标题/说明的提示，忽略其分支含义。',
    '- 未指定时依次探测：`git symbolic-ref --short refs/remotes/origin/HEAD`（去掉 `origin/` 前缀）→',
    '  `git ls-remote --symref origin HEAD` → `main` → `master` → 远端第一个非 HEAD 的分支。',
    '- 最后用 `git ls-remote --heads origin <base>` 确认它真实存在。',
    '',
    '## 3. 处理当前分支',
    '- 当前分支**等于 base** 时不要停在那儿：把要做的工作挪到特性分支上——',
    '  有未提交改动或领先提交时，按改动内容起一个 kebab-case 的分支名（如 `feat/login-timeout`），',
    '  `git switch -c <分支名>` 之后再提交/推送。',
    '- 工作区有未提交改动时，先按 `/commit` 的规则完成一次提交；不要带着未提交的改动去开 PR。',
    '- `git log origin/<base>..HEAD --oneline` 为空说明没有领先的提交，这时如实说明并结束。',
    '',
    '## 4. 推送',
    '- 没有上游时 `git push -u origin HEAD`，否则 `git push`。',
    '- 推送被拒绝（非快进、权限、保护分支）就原样报告并停止。',
    '',
    '## 5. 生成标题与正文',
    '- 标题：优先用分支上唯一提交的主题行；多个提交时归纳成一句看得懂的话。语言跟随仓库，不超过 72 字符。',
    '- 先看仓库有没有 PR 模板：`.github/PULL_REQUEST_TEMPLATE.md`、`.github/pull_request_template.md`、',
    '  `PULL_REQUEST_TEMPLATE.md`、`docs/PULL_REQUEST_TEMPLATE.md`、`.gitlab/merge_request_templates/Default.md`；',
    '  有就沿用它的章节结构，没有就用「## 变更内容 / ## 验证」两段。',
    '- 正文只写能从提交与 diff 确认的事实，**绝不编造测试结果或性能数据**；确实没跑测试就写「未运行自动化测试」。',
    '- 标题与正文用临时文件或 `--body-file` 传递，避免引号和换行的转义问题。',
    '',
    '## 6. 创建（按可用性逐级降级，每级失败都继续往下试）',
    '- **GitHub 且 `gh` 可用且已登录**（`gh auth status` 成功）：',
    '  `gh pr create --base <base> --head <branch> --title <标题> --body-file <文件>`。',
    '  已存在同 head 的 PR 时该命令会失败：改用 `gh pr list --head <branch> --state open --json url` 汇报现有链接，不要重复创建。',
    '- **GitHub 且无 gh 但有 `GITHUB_TOKEN` / `GH_TOKEN`**：`POST https://api.github.com/repos/<owner>/<repo>/pulls`',
    '  （GitHub Enterprise 用 `https://<host>/api/v3/...`）。422 且提示已存在时，查 `GET .../pulls?head=<owner>:<branch>&state=open` 拿现有链接。',
    '- **GitHub 且都没有**：推送完成后给出预填链接',
    '  `<webBase>/compare/<base>...<branch>?expand=1&title=<编码后的标题>&body=<编码后的正文>`，',
    '  明确告诉用户点开后按「Create pull request」即可。',
    '- **GitLab**：`glab mr create --source-branch <branch> --target-branch <base> --title … --description … --yes`，',
    '  否则给出 `<webBase>/-/merge_requests/new?merge_request[source_branch]=…&merge_request[target_branch]=…` 链接。',
    '- **其他平台**：给出 `<host>/<owner>/<repo>/compare/<base>...<branch>` 链接。',
    '',
    '## 7. 汇报',
    '给出 PR/MR 链接、源分支 → 目标分支、标题，以及是用哪种方式创建的（CLI / API / 网页链接）。',
    '降级到链接时，说清楚用户只需要点一下，别把它说成失败。',
    '',
    RULES,
  ].join('\n')
}

/** `/commit-pr` 的操作规程：一次上下文检查，做完前两件事。 */
function commitPrInstruction(rawInput) {
  const hint = rawInput.trim()
  return [
    '请一次完成：提交当前改动 → 推送 → 创建 Pull Request / Merge Request。',
    ...(hint === '' ? [] : ['', `用户这次给的参数（可能是目标分支，也可能是标题或说明）：\`${hint}\``]),
    '',
    '规则与 `/commit`、`/create-pr` 完全一致（安全审查、不用 force、不跳过钩子、不编造验证结果），',
    '区别只是**上下文只检查一次**，然后连着做完：',
    '',
    '1. 确认仓库、分支与远端；detached HEAD 就先建分支。',
    '2. 按 `/commit` 的规程做安全审查并提交（没有改动就跳过提交这一步，不要造空提交）。',
    '3. 按 `/create-pr` 的规程确定 base；**当前分支等于 base 时按改动内容新建特性分支**，不要硬停在这里。',
    '4. 推送（无上游则 `git push -u origin HEAD`）。',
    '5. 生成标题与正文（有 PR 模板就沿用），按 gh → token API → 网页链接的顺序创建。',
    '6. 汇报：提交哈希与提交信息、PR/MR 链接、源分支 → 目标分支、创建方式；',
    '   推送或创建失败时如实给出卡在哪一步以及原始错误。',
    '',
    RULES,
  ].join('\n')
}

/** 递归冻结（与宿主 `createUserMessage` 的做法一致，避免消息在队列里被就地改写）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * 构造一条 user 消息。
 *
 * 刻意不 import 官方包里的 `createUserMessage`：本仓库的硬性约束是 Host 半只用 `node:*`，
 * 而且插件包没有声明对官方包的依赖，跨包解析在 profile 里并不可靠。
 * 这里复刻它唯一有意义的几步——生成 id、带上 `role`/`source`、深冻结。
 * @param text - 指令正文。
 * @returns 可以直接交给 `agent.followup()` 的消息。
 */
function createInstructionMessage(text) {
  return deepFreeze(
    structuredClone({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'git-pr' },
    }),
  )
}

/**
 * 把指令排进会话并唤醒驱动。
 *
 * 与 `/goal` 用的是同一套机制：命令本身立即返回，模型在下一轮真的去执行。
 * @param invocation - 命令调用。
 * @param text - 指令正文。
 * @param summary - 回报给用户的一句话。
 * @returns 命令结果。
 */
function enqueue(invocation, text, summary) {
  const agent = invocation?.agent
  if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
    return { kind: 'error', text: '这个命令需要在会话里执行——当前没有可用的 Agent，指令没法排进会话。' }
  }
  try {
    agent.followup(createInstructionMessage(text))
  } catch (error) {
    return { kind: 'error', text: `指令没能排进会话：${error instanceof Error ? error.message : String(error)}` }
  }
  return { kind: 'success', text: summary }
}

/** 三个命令的定义。 */
export function definitions() {
  const run = (build, summary) => async (invocation) => {
    try {
      return enqueue(invocation, build(invocation?.rawInput ?? ''), summary)
    } catch (error) {
      return { kind: 'error', text: `执行失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return [
    {
      name: 'commit',
      description: '提交当前改动：安全审查、按仓库风格写提交信息、完成本地提交（不推送）',
      input: { hint: '[可选的路径范围（如 src/）或提交说明补充]' },
      handler: run(commitInstruction, '已把「提交代码」交给模型执行：它会先做安全审查，再按仓库风格提交。'),
    },
    {
      name: 'create-pr',
      description: '推送当前分支并创建 Pull Request / Merge Request，自动判断 GitHub 或 GitLab',
      input: { hint: '[目标分支] [可选的标题或说明补充]' },
      handler: run(createPrInstruction, '已把「创建 PR」交给模型执行：它会处理分支、推送与 PR 文案。'),
    },
    {
      name: 'commit-pr',
      description: '一次完成提交、推送和创建 PR/MR',
      input: { hint: '[目标分支] [可选的标题或说明补充]' },
      handler: run(commitPrInstruction, '已把「提交并创建 PR」交给模型执行，一次走完。'),
    },
  ]
}

/**
 * 安装三个命令。
 *
 * 不导出 Config schema：这个插件没有需要用户配置的字段（模型路由、超时都由宿主决定）。
 * @param ctx - 拥有这些注册的插件上下文。
 */
export function apply(ctx) {
  for (const definition of definitions()) {
    ctx.effect(() => ctx.commands.register(definition), `git-pr: /${definition.name}`)
  }
  try {
    ctx.logger?.info?.('[git-pr] 已启用：/commit、/create-pr、/commit-pr（把操作规程交给模型执行）')
  } catch {
    /* 日志失败不影响功能 */
  }
}

// 供 smoke 复用。
export const __internals = {
  RULES,
  commitInstruction,
  createPrInstruction,
  commitPrInstruction,
  createInstructionMessage,
  enqueue,
  deepFreeze,
}
