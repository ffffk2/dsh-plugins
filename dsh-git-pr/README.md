# @local/dsh-git-pr

三个斜杠命令，用来「提交代码」和「建 PR」：

| 命令 | 作用 |
|---|---|
| `/commit` | 提交当前改动（只到本地，不推送） |
| `/create-pr` | 推送当前分支并创建 PR / MR |
| `/commit-pr` | 一条命令完成提交 + 推送 + 建 PR |

```
/commit                    提交全部改动
/commit src/ backend       只提交这些路径
/commit 修复登录超时        把参数当作提交说明的提示
/create-pr                 推到默认分支（自动探测）
/create-pr develop         以 develop 为目标分支
/commit-pr 补充性能测试说明  当作 PR 标题/正文的提示
```

## 它到底做了什么

**它不自己执行 git，而是把一套操作规程连同你的参数交给你正在用的模型，让它按现场情况去做。**

为什么这么设计：这批操作几乎每一步都依赖现场判断——有没有改动、在不在主干上、要不要新建
特性分支、提交信息用什么语言、PR 目标分支是哪个、有没有 PR 模板、`gh` 能不能用。把这些写死在
插件代码里，就会退化成「工作区干净 ⇒ 报错」「在主干上 ⇒ 报错」这种硬门槛，而你真正想要的是
**像直接对 dsh 说一句「提交代码」那样，让它自己看着办**。

所以命令做的事，和你在输入框里打一段要求、然后回车，本质是同一个动作：

```
你发 /commit-pr develop
      ↓
插件把「操作规程 + develop」拼成一条 user 消息，排进当前会话并唤醒模型
      ↓
模型用自己的工具执行：检查 → 提交 → 推送 → 建 PR
```

机制与官方 `/goal` 一致：命令本身立即返回，活儿由模型在下一轮真的去干。

## 规程里写死了什么

规程是确定性的——它不会因为模型的心情变化而漏掉关键约束。每条命令都内联了同一段硬性约定：

- **不许** `--force` / `--force-with-lease`，**不许** `--no-verify` 跳过钩子；
- 不改 `.git/config`，不写任何凭据文件；token 只从环境变量读，绝不回显；
- 提交前**不 review**：你发起命令时改动已经看过，直接暂存并提交；
- 每一步以真实命令输出为准，失败如实报告，不假装成功。

### 提交（`/commit`、`/commit-pr`）

1. 确认仓库与分支；detached HEAD 时**新建分支继续**，而不是直接失败；
2. 只看 `git status` / `git diff --stat` / `git log --oneline -20`：你发起命令前已经 review 过，
   所以它**不通读完整 diff**，也不会停下来等你确认；
3. 没有改动就如实说明，**不造空提交**；
4. 暂存（默认 `git add -A`，给了路径就只加那些路径）并提交；
5. 提交信息**跟随仓库最近 20 条的风格与语言**，主题行 ≤72 字符，不加工具署名。

### 建 PR（`/create-pr`、`/commit-pr`）

- 平台从 `origin` 的 URL 判断（`git@…`、`ssh://…`、`https://…` 都认，自建 GitLab 的多层命名空间也保留）；
- 目标分支按 `origin/HEAD` → `ls-remote --symref` → `main` → `master` → 远端第一个分支探测；
- **当前就在目标分支上时不报错**：按改动内容新建一个特性分支再走；
- 有未提交改动时先完成提交，不带着脏工作区开 PR；
- 创建按可用性逐级降级，每级失败都继续往下试：

| 顺序 | GitHub | GitLab |
|---|---|---|
| 1 | `gh pr create`（已登录） | `glab mr create`（已登录） |
| 2 | `GITHUB_TOKEN` / `GH_TOKEN` 调 REST API | `GITLAB_TOKEN` / `GLAB_TOKEN` 调 REST API |
| 3 | 预填 `compare/<base>...<head>?expand=1` 链接 | 预填 `/-/merge_requests/new?…` 链接 |

第 3 级只是打开一个网页，所以**永远可用**：没装 `gh`、没有 token 也能推送成功，然后给你一个
点一下就行的链接，并说明为什么退到了这一步。已存在同分支 PR 时给现有链接，不重复创建。
PR 正文只写能从提交与 diff 确认的事实，**绝不编造测试结果**。

## 安装

```json
{
  "dsh": { "profile": { "bundles": ["@local/dsh-git-pr"] } },
  "dependencies": { "@local/dsh-git-pr": "link:<本仓库路径>/dsh-git-pr" }
}
```

在 profile 目录跑 `pnpm install`（`link:` 会自己建好 `node_modules/@local/dsh-git-pr`）。
改 `dependencies`/`bundles` **必须重启 DSH**。

## 与 dsh-git 的分工

两者互不依赖，可以同时装：

- **dsh-git** 是右侧栏的可视化面板：看 diff、挑文件暂存、切分支、翻历史。
- **dsh-git-pr** 是命令：适合「这批改动帮我提交了」「推上去开个 PR」这种一句话的事。

## 验证

```powershell
node dsh-git-pr\smoke.mjs   # 通过时打印 ALL PASS
```

冒烟测试断言三类事：**注册契约**（三个命令真的注册了、名字合法、描述与 hint 齐全）、
**指令质量**（每条命令的指令都必须带着全部硬性约定——不许 force、不许跳过钩子、
提交前不额外 review、不编造验证结果；缺一条就等于那条命令会出事故）、
**投递行为**（handler 真的调用 `agent.followup()`、消息结构合法且被深冻结、用户参数真的带进去了、
没有 Agent 或 followup 抛异常时给出明确错误而不是把异常抛给宿主）。
