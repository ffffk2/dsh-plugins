# @local/dsh-git-pr

三个斜杠命令，用一句话完成「提交代码」和「建 PR」：

| 命令 | 作用 |
|---|---|
| `/commit` | 审查改动、安全扫描、暂存，按仓库既有风格写提交信息并提交（**只到本地，不推送**） |
| `/create-pr` | 推送当前分支并创建 PR / MR；平台按 `origin` 自动判定 GitHub 或 GitLab |
| `/commit-pr` | 一条命令完成提交 + 推送 + 建 PR |

参数：

```
/commit                    提交全部改动
/commit src/ backend       只提交这些路径
/commit 修复登录超时        把参数当作提交说明的提示
/create-pr                 推到默认分支（自动探测）
/create-pr develop         以 develop 为目标分支
/create-pr 补充性能测试说明  当作 PR 标题/正文的提示
/commit-pr develop         提交后以 develop 为目标分支
```

参数指的是**仓库内已存在的路径**时才当路径范围用；只要有一个 token 不像路径，
整串就当作说明文字——不会出现「我想写说明，结果它按路径去 add 了」这种事。

## 为什么不做成提示词模板

ZCode 那套 `commands/*.md` 是提示词：每次执行都要模型重新读一遍规则、重新拼 git 命令，
既慢又会在细节上漂移（`--no-verify` 忘了一次、`--force` 手滑一次就够受）。

这里把流程固化成确定性代码，模型只负责**写文案**——那才是真正需要判断的部分：

```
检查仓库/分支 → 安全扫描 → 暂存 → 生成提交信息 → commit → push → 建 PR
                  ↑                                          ↑
              纯代码，不经过模型                        模型只写这几段文字
```

于是：规则不会漂移，失败可复现，速度快；模型不可用时还能降级跑通（见下）。

## 提交信息怎么来

1. 取 `git log -20` 学语言与格式（Conventional Commits 还是纯中文描述）；
2. 把「改动统计 + 改动文件 + 截断后的 diff」喂给模型（走 `ctx.llm`，不动会话历史）；
3. 用 `git commit -F -` 把结果从 **stdin** 递进去——避免引号与换行的转义地狱。

提示词里明确禁止 `Generated with …` / `Co-authored-by` 之类的工具署名。

**模型不可用时**（没配模型、调用超时、返回空）：退化成按改动推断一行主题
（如 `更新 src（3 个文件）`），并在结果里写明「提交信息由规则生成，建议
`git commit --amend` 改一版」。不会假装模型写过。

模型路由的优先级：插件配置 `provider`/`model` > 会话最近一次请求的路由 >
宿主默认模型。

## 安全

**先扫描，再动索引。** 命中就整条命令中止，暂存区一个字节都不改——所以你自己
`git add` 过的东西不会被我们回滚。

| 拦什么 | 例子 |
|---|---|
| 凭据文件 | `.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`id_rsa*`、`credentials*`、`.npmrc`、`.netrc` |
| 密钥字面量 | 赋值号右边是真实密钥的 `password`/`secret`/`token`/`api_key`…，以及 `ghp_*`、`AKIA*`、`glpat-*`、`xox?-*`、`sk-*`、私钥块 |
| 超大文件 | 单个超过 5 MB（基本都是误提交的二进制） |

不误伤是刻意的：`password: process.env.X`、`token = readConfig()`、
`secret: '<REPLACE_ME>'` 都放行——误报两次之后用户就会绕开扫描，那比漏报更糟。

其他约定：

- 不用 `--force` / `--force-with-lease`，不用 `--no-verify`；
- 不改 `.git/config`，不写任何凭据文件，token 只从环境变量读且绝不回显；
- 所有 git 调用是 `execFile('git', [...args])`（数组、不经 shell），
  分支名与路径里的空格引号不需要转义，也就没有命令拼接注入；
- `GIT_TERMINAL_PROMPT=0`：需要凭据时**立刻失败**，而不是把宿主挂在那里等输入。

## PR 创建：按平台自动降级

平台从 `origin` 的 URL 判定（`git@host:owner/repo.git`、`ssh://…`、`https://…` 都认，
自建 GitLab 的多层命名空间也保留）；默认目标分支按
`origin/HEAD` → `ls-remote --symref` → `main` → `master` → 远端第一个分支探测。

| 顺序 | GitHub | GitLab |
|---|---|---|
| 1 | `gh pr create`（已登录时） | `glab mr create`（已登录时） |
| 2 | `GITHUB_TOKEN` / `GH_TOKEN` 调 REST API | `GITLAB_TOKEN` / `GLAB_TOKEN` 调 REST API |
| 3 | 预填 `compare/<base>...<head>?expand=1&title=…&body=…` 链接 | 预填 `/-/merge_requests/new?…` 链接 |

第 3 级**永远可用**（它只是打开一个网页），所以没装 `gh`、没有 token 也能用：
推送会照常完成，然后把「点一下这个链接」和「为什么没能自动建」一并说清楚。
「已存在同分支的 PR」时不会重复建，而是把现有那个的链接给你。

推送失败（非快进、权限、保护分支）一律**原样报错并停下**，不会偷偷 force。

## 前置检查

建 PR 之前会真的检查，而不是带着问题往前走：

- 不在 git 仓库里 → 明确报错；
- detached HEAD → 提示先切分支；
- 当前就在目标分支上 → 拒绝（没有可开 PR 的内容）；
- 远端没有目标分支 → 拒绝，并提示用 `/create-pr <分支名>`；
- 工作区还有未提交的改动 → 拒绝并建议先 `/commit`（否则 PR 里没有那些改动，
  但看 PR 的人会以为有）；
- 领先 base 的提交为空 → 拒绝。

## 安装

```json
{
  "dsh": { "profile": { "bundles": ["@local/dsh-git-pr"] } },
  "dependencies": { "@local/dsh-git-pr": "link:<本仓库路径>/dsh-git-pr" }
}
```

在 profile 目录跑 `pnpm install`（`link:` 会自己建好 `node_modules/@local/dsh-git-pr`）。
改 `dependencies`/`bundles` **必须重启 DSH**；纯 patch 行改动是即时的。

## 配置

全部可选，不写就按默认行为：

```yaml
- id: git-pr
  name: '@local/dsh-git-pr'
  config:
    provider: codebuddy-cli     # 写文案用的模型；与 model 必须成对出现
    model: deepseek-v4.1-flash
    registerTool: true          # 是否额外注册 git_commit_pr 工具（默认 true）
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | 空 | 写文案用的路由。留空则跟随会话最近一次请求的路由，再退到宿主默认模型。只填一个视为没填。 |
| `registerTool` | `true` | 注册 `git_commit_pr` 工具，让模型也能自己调（「帮我提交并开个 PR」就不用记斜杠命令）。 |

## 与 dsh-git 的分工

两者互不依赖，可以同时装：

- **dsh-git** 是右侧栏的可视化面板：看 diff、挑文件暂存、切分支、翻历史。
- **dsh-git-pr** 是命令：适合「这批改动帮我提交了」「推上去开个 PR」这种一句话的事。

要精细控制提交哪些文件，用 dsh-git 面板；要一步到位，用斜杠命令。

## 验证

```powershell
node dsh-git-pr\smoke.mjs   # 通过时打印 ALL PASS
```

冒烟测试会真的建一个临时仓库 + 本地 bare 仓库当远端，跑完整流程并断言：
提交真的产生了、路径范围真的生效、`.env` 与硬编码密钥真的被拦住且**没有动暂存区**、
`process.env` 写法**不**被误伤、在 base 分支上真的被拒、本地路径远端会明确说「没有
PR 平台」而不伪造链接、推送失败时如实报错。另有纯函数断言（远端 URL 解析、
porcelain `-z` 解析、模型输出解析、PR 链接生成）与包契约断言。
