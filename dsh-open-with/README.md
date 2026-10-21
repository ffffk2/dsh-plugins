# @local/dsh-open-with

给 DSH 的会话头部加一个「用其他应用打开工作区」按钮。内置 CodeBuddy、cmd、PowerShell，
应用列表**完全由配置驱动**：以后要加 Cursor、Trae、Warp、Typora 之类，只改一行 YAML，
不用改代码、不用重新打包。

## 为什么需要它

DSH 自带的「打开方式」菜单来自 `@deepseek-ai/dsh-host-open-in-app` 里一张**编译期写死的白名单**
（`OPEN_IN_APP_CATALOG`），官方 README 明确写着「目录在构建期固定，部署无法从 cordis.yml 增加」。
所以自带菜单里只有 Cursor / IntelliJ / PhpStorm / Git Bash 那几项，加不了 CodeBuddy。

本插件在同一个 `conversation.session.header.utilities` 插槽里并排放一个自己的按钮，
清单、图标、启动全部自己实现，因此想加什么就加什么。

## 加一个新的打开方式

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml` 里本包的 `apps:`，加一条，保存即可
（HMR 会重载插件；没看到新条目再重启 DSH，无需重装）：

```yaml
- id: open-with
  name: '@local/dsh-open-with'
  config:
    apps:
      - id: codebuddy                      # 稳定标识，改了会丢「上次选择」
        label: CodeBuddy                   # 菜单显示名
        exe:                               # 候选 exe，按顺序取第一个存在的
          - '${ProgramFiles}/CodeBuddy CN/CodeBuddy CN.exe'
          - '${ProgramW6432}/CodeBuddy CN/CodeBuddy CN.exe'
        registry:                          # 可选的 Windows 兜底（装在非 C 盘也能找到）
          displayNamePrefix: CodeBuddy CN  # 卸载记录 DisplayName 的前缀
          exe: [CodeBuddy CN.exe]          # InstallLocation 下的文件名
      - id: trae
        label: Trae
        exe:
          - '${LOCALAPPDATA}/Programs/Trae CN/Trae CN.exe'
        registry:
          displayNamePrefix: TRAE CN
          exe: ['Trae CN.exe']
      - id: typora
        label: Typora
        args: ['{path}']                   # 含 {path} 就代入目录，否则目录追加到末尾
        exe:
          - '${ProgramFiles}/Typora/Typora.exe'
```

写进去的应用只是**候选**：只有本机真的能验证出可执行文件的条目才会出现在菜单里，
所以可以把一整队应用都写进配置，换台机器也不用改。

### 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 稳定标识（ASCII）。改了会丢失「上次用过的应用」记忆 |
| `label` | 是 | 菜单里显示的名字 |
| `exe` | 否 | 候选可执行文件，支持 `${VAR}` / `%VAR%` / 开头 `~/`，按顺序取第一个存在的 |
| `registry` | 否 | Windows 兜底：`displayNamePrefix` + `exe`，按卸载记录的 `InstallLocation` 找 |
| `args` | 否 | 启动参数模板；含 `{path}` 时替换成目录，否则目录追加到末尾（`shell: true` 时不追加） |
| `cwd` | 否 | 启动时的工作目录模板，支持 `{path}` 与 `${VAR}`；相对路径按工作区解析，不写则终端类用工作区目录 |
| `shell` | 否 | 默认 `false`。终端类应用（cmd / PowerShell）必须设 `true`，见下方「终端」 |
| `env` | 否 | 额外注入的环境变量 |
| `iconPath` | 否 | 图标文件（PNG/SVG）。不写则 Windows 从 exe 提取真实图标，其它平台用占位图 |
| `watchMs` | 否 | 早期失败看护窗口（毫秒），默认 1200 |
| `tolerateExitCode` | 否 | 默认 `true`。见下方「单实例应用」；终端类建议设 `false` |
| `platforms` | 否 | 限定平台：`win32` / `darwin` / `linux`；不写表示全平台 |

`cwd` 只改被启动进程的当前目录：终端类应用由 `start /d` 负责，所以 `args` 里直接写
`npm run serve` 即可，不必再拼 `cd /d ...`（那样还容易因为引号被 spawn 转义而失效）。

### 顶层字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `apps` | 内置 CodeBuddy / cmd / PowerShell 三条候选 | 应用清单；留空等同于用内置默认 |
| `workspaces` | 无 | 按工作区筛选的规则，见下方「按工作区筛选」 |
| `defaultApps` | 无（不筛选） | 没有命中任何 `workspaces` 规则的工作区展示哪些 id |
| `probeTimeoutMs` | 8000 | 探测（注册表查询）的单条命令期限 |
| `iconTimeoutMs` | 8000 | 图标提取的单条命令期限 |
| `launchWatchMs` | 1200 | 启动看护窗口 |

## 按工作区筛选（不同目录显示不同应用）

同一个 DSH 里开着代码库和文档库时，菜单没必要把 Typora 和 IDE 都列出来。
在 profile 的 `cordis.patch.yml` 里，本包那条 `config:` 下加 `workspaces`，
按会话的工作区目录（会话的 `cwd`）决定菜单里出现哪些应用，**按顺序取第一条命中的规则**：

```yaml
config:
  apps:
    - { id: codebuddy, label: CodeBuddy, exe: [...] }
    - { id: typora, label: Typora, exe: [...] }
    - { id: cmd, label: 命令提示符, shell: true, exe: [...] }
  workspaces:
    - match: 'D:/docs/**'                # 文档库：只留 Typora 和终端
      apps: [typora, cmd]
    - match: ['D:/code/**', 'E:/work']   # 代码库：编辑器 + 终端
      apps: [codebuddy, cmd]
    - match: 'D:/private'                # 这个工作区一个都不显示（按钮隐藏）
      apps: []
  defaultApps: [codebuddy, cmd]          # 都没命中时用这份；不写 = 全部可用
```

匹配规则：

- `match` 可以是单个字符串或数组，数组里任意一条命中就算命中。
- 不含通配符时按**目录前缀**解释：`match: 'D:/code/app'` 命中该目录及其所有子目录。
- `*` 匹配任意个非 `/` 字符（不跨目录），`**` 跨目录，`?` 匹配单个非 `/` 字符；
  结尾的 `/**` 也包含目录本身（`D:/code/**` 命中 `D:/code`）。
- Windows 下大小写不敏感，`\` 与 `/` 等价；macOS / Linux 大小写敏感。
- 第一条命中的规则生效，后面的不再看；`apps: []` 合法，表示该工作区不显示按钮。
- 菜单是本机可用应用与规则允许项的交集。Host 侧的 `POST /open-with/open` 也会再验一次，
  被过滤的条目返回 403，不会启动。
- 「上次用过的应用」同样按工作区各记一份，在文档库里选 Typora 不会顶掉代码库的选择。
- 这是菜单可见性约束，不是安全边界：能在本机发请求的人本来就能启动任意程序。

改完 profile 配置即时生效（HMR）；菜单没变就再刷新一次页面或重启 DSH。

## 单实例应用（重要）

Electron 系编辑器（CodeBuddy、Cursor、VS Code…）**已经开着**的时候，新进程会把「打开这个目录」
转交给已运行的实例，然后自己退出，退出码常常是 `1`。如果把这当成失败，用户会看到
「打开失败，请重试」但窗口明明已经跳过去了。

所以默认 `tolerateExitCode: true`：看护窗口内收到非零退出码也算启动成功。
真正的 spawn 失败（exe 不存在、权限不足）仍然会报错，不会漏。

## 终端（cmd / PowerShell）

内置的 `cmd` 和 `powershell` 两条就是「在新终端里打开当前工作区」：

- 必须写 `shell: true`。DSH 宿主是没有控制台的 GUI 进程，直接 spawn 控制台程序拿不到可见窗口；
  插件改走 `cmd /c start /d <目录> "" <程序> <参数...>`，由 shell 自己分配新控制台。
- 起始目录由 `start /d` 指定，所以 `args` 里不需要再写 `cd`，插件也不会把目录追加到末尾。
- 这两条显式设了 `tolerateExitCode: false`：终端不是单实例应用，`start` 找不到目录或程序时
  会以非零码退出，应该如实报「打开失败」，而不是像 IDE 那样容忍。
- PowerShell 的 `Set-Location -LiteralPath '{path}'` 是双保险：万一 `start /d` 被改坏，
  窗口里的当前位置仍会落到工作区。路径里含单引号时需要在配置里自行转义。

## 踩过的坑：终端窗口不出现（重复加引号）

**症状**：点 cmd / PowerShell，路由返回 `200`，但一个窗口都没有；进程列表里多出一个
没有窗口的 `cmd.exe /c start ...`。

**根因**：`shellLaunchCommand` 曾经先给目录和程序名手工套一层引号。Node 的 spawn 在 Windows 上
会自己给含空格的参数加引号，并把参数内部已有的 `"` 转义成 `\"`。于是
`start /d "C:\..."` 最终变成 `start /d "\"C:\...\""`，`start` 找不到目录，窗口不出现。
看护窗口只等 1.2 秒，看到进程还活着就当成功了，所以路由照样返回 200。

**修法**：`shellLaunchCommand` 只做反斜杠规范化（`start` 对正斜杠敏感），引号全部交给 spawn。
`smoke.mjs` 里有回归用例，断言 argv 里不允许出现手工引号。

**排查手法**：看 `Get-CimInstance Win32_Process` 里挂着的 `cmd.exe /c start` 命令行，
出现 `\"` 就是这个问题；正常应该是 `start /d "C:\..." "" ...`。

## Host 路由

三条路由都先过 `connection` 的 Host/Origin 围栏（非本机同源直接拒）：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/open-with/apps?path=<绝对路径>` | GET | `{ apps: [{ id, label }] }`，只含本机可用且在该工作区允许的条目；不写 `path` 时按 `defaultApps` 处理 |
| `/open-with/icon/<id>` | GET | 该应用的真实图标（PNG / SVG），提取不到返回 404 |
| `/open-with/open` | POST | `{ app, path }`，用指定应用打开目录；被工作区规则拒绝时返回 403 |

解析结果每进程只算一次；启动时发现 exe 已消失（`ENOENT`）会当场重解析该条目一次，
所以**卸载方向能自愈**，新装的应用则要重启 DSH 才会出现——和官方 open-in-app 的行为一致。

## 自检

```bash
node --check index.js && node --check client.js
node smoke.mjs          # 纯函数：模板展开、配置归一化、注册表解析、图标、argv
node smoke-routes.mjs   # 路由级：三条路由的注册/校验/真实启动，用假 ctx 直接调 handler
```

`smoke-routes.mjs` 是端到端的那一层：它会真的把本机探测到的应用拉起来一次，
所以跑之前请确保那个应用允许被反复唤醒。

## 已知边界

- **不含文件打开**：只处理「用某个应用打开工作区目录」。文件菜单仍归官方 `open-in-app` 管。
- **图标只在 Windows 从 exe 提取**：macOS/Linux 需要显式配 `iconPath`，否则显示占位图。
- **探测是每进程一次**：装完新应用要重启 DSH 才出现在菜单里。
- **工作区按字符串比较**：规则匹配会话 `cwd` 的原文，不做 realpath。通过符号链接、
  Windows 8.3 短路径或不同盘符映射访问的同一目录，需要各自写进 `match`。
- **工作区规则不是安全边界**：它决定菜单里显示什么，Host 只做同样的二次校验，
  不当作权限系统。

## 踩过的坑：点了没反应（`ELECTRON_RUN_AS_NODE`）

这是本插件第一版真实翻车过的 bug，记在这里免得以后重犯。

**症状**：点按钮，接口返回 200，但目标编辑器一个进程都没起来，也没有任何报错。

**根因**：DSH 桌面版自己是 Electron 应用，它的进程环境里带着
`ELECTRON_RUN_AS_NODE=1`。`spawn` 时若把父进程环境原样传下去，被抓起来的编辑器
（CodeBuddy / Cursor / VS Code 全都是 Electron）会读到这个变量并**退化成纯 Node 模式**：
它不再开窗口，而是把命令行参数当成入口脚本去 `require`，于是报

```
Error: Cannot find module 'D:\code\java\cc'
```

然后静默退出——用户侧看起来就是「点了没反应」。

**修法**：`launchEnvironment()` 在 spawn 前剥掉 Electron/Node 的运行时开关
（`ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`NODE_ENV` 等），其余环境照常继承，
配置里显式声明的 `env` 不受限制。`smoke.mjs` 里有 5 条回归用例钉住这个行为。

**排查手法**：这类「200 但没反应」要先看进程数，别信返回码——
本插件当时的 `launchDetached` 是「退出码 0 或容忍都算成功」，
目标进程秒退时它也返回成功。真正确认要看目标应用是否真的多出了进程。
