# @local/dsh-git

在 DSH 右侧栏里用可视化方式操作 Git，参照 VS Code 的源代码管理面板。

## 它长什么样

右侧栏的「+」引导卡片列表里，**Git** 排在「浏览器」下面。点一下就开一个 Git tab，
可以多开、可以拖到分屏、可以浮动——和浏览器、文档预览是同一套 tab 机制。

tab 打开后有三个页签：

| 页签 | 内容 |
|---|---|
| **更改** | 提交信息框 + 「暂存的更改 / 更改」两组文件列表；每行 hover 出 `+`（暂存）、`−`（取消暂存）、`↺`（放弃更改）；点文件名就地展开 unified diff（绿加红删、双行号、hunk 头） |
| **历史** | 分页加载的提交列表（短 hash、作者、时间、分支/标签），点开看提交详情与该次提交的文件，再点文件看那次 diff |
| **分支** | 本地/远程分支列表、当前分支高亮、切换、新建、删除；顶部按钮做 fetch / pull / push，没有上游时给「发布分支」 |

顶部还常驻：当前分支（点它跳到分支页）、ahead/behind 计数、刷新。
提交框支持 `Ctrl+Enter`（macOS `Cmd+Enter`）；工作区有改动时可以「贮藏更改」，
有贮藏时能恢复或删除。

工作目录不是 Git 仓库时，面板给出路径输入框与「初始化仓库」，不会一片空白。

## 原理

一如既往是「Host 半 + Client 半」：

**Host 半（`index.js`）** 用 `execFile('git', [...])` 直接调 git CLI——不引入任何
git 库，也不开 shell，所以分支名/路径里的空格与引号不需要转义，也不存在命令拼接注入。
它把操作包成几条同源路由：

| 路由 | 用途 |
|---|---|
| `GET /git/status` | 仓库概要、暂存区/工作区变更、分支与远程状态、贮藏列表 |
| `GET /git/diff` | 单个文件的 unified diff（`staged=true` 看暂存区，`commit=<hash>` 看某次提交） |
| `GET /git/log` | 提交历史（`limit` / `skip` / `branch` / `file`） |
| `GET /git/commit` | 单次提交的详情与改动文件 |
| `GET /git/branches` | 本地与远程分支 |
| `POST /git/action` | 所有写操作，按 `action` 分派 |

几条能说明取舍的细节：

- **`-c core.quotepath=false`**：git 默认把非 ASCII 路径转义成八进制，中文文件名会变成
  `\344\270\255` 这样的乱码。这是纯显示问题，但足够让人以为插件坏了。
- **porcelain 用 `-z`**：NUL 分隔是唯一无歧义的状态格式，重命名的原路径也靠它配对。
- **路径闸门**：`resolveRepo` 只接受绝对路径、要求目录真实存在，再 realpath 消掉符号链接；
  可用配置里的 `roots` 限定到若干根目录。这是唯一的路径入口。
- **未跟踪文件也能看 diff**：git 没有可比较对象，用 `--no-index` 对着空文件生成新增差异，
  读起来和 VS Code 一致。
- **写操作后回报最新状态**：省一次往返，也顺手消灭「提交完列表没变」这类错觉。
- **超时与截断**：普通命令 20s、网络命令 120s；diff 超过 40 万字符截断并标记，
  避免一个巨型 diff 把页面卡死。

**Client 半（`client.js`）** 只 `require('react')`，通过 `ctx.sidebarRightTabs.register`
注册 tab 类型（`kind: 'git'`），再用 `slots` 把主体与标题挂到
`sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 上。样式全部走宿主主题 token
（`--dsw-alias-*`），没有硬编码颜色，所以跟随明暗主题。

## 安装

profile 的 `package.json`：

```json
{
  "dsh": { "profile": { "bundles": ["@local/dsh-git"] } },
  "dependencies": { "@local/dsh-git": "link:<本仓库路径>/dsh-git" }
}
```

在 profile 目录跑 `pnpm install`（`link:` 会自己建好 `node_modules/@local/dsh-git`）。
改 `dependencies`/`bundles` **必须重启 DSH** 才生效；纯 patch 行改动是即时的。
Client 半在重启后刷新一次页面即可看到。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `roots` | `[]` | 允许操作的根目录数组。为空表示不限制（仍要求是真实存在的目录且在 git 仓库里）。填了就只接受这些目录及其子目录。 |
| `gitPath` | `"git"` | git 可执行文件。PATH 里没有 git 时指向绝对路径。 |

```yaml
- id: git
  name: '@local/dsh-git'
  config:
    roots:
      - 'D:\code'
```

## 验证

```powershell
node dsh-git\smoke.mjs   # 通过时打印 ALL PASS
```

冒烟测试两半都跑：Host 侧验证解析器（porcelain `-z`、log 字段流）、路径闸门，
并真的对一个**临时 git 仓库**做完整流程（暂存 → 提交 → 改文件 → 看 diff →
新建分支 → 放弃修改）；Client 侧在 Node 里用极简 React 真跑注册契约与渲染，
断言中英文字典键一致、CSS 里没有硬编码颜色、只依赖 `react`。

`DSH_SMOKE_DEBUG=1` 会打印渲染出的 HTML 摘要。

## 已知限制

- 提交历史是线性的列表（带分支线的小挂件），不是完整的多分支拓扑图。
- 冲突文件只标记、不提供三方合并编辑；请在编辑器里解决后回来暂存。
- 不支持交互式 rebase、cherry-pick、submodule 等进阶操作。
- 网络操作（fetch/pull/push）不弹凭据输入框，`GIT_TERMINAL_PROMPT=0`，
  需要凭据时会直接失败并在面板上显示 git 的报错。
