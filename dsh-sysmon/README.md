# dsh-sysmon

在 DSH 界面**左下角**常驻一枚系统资源 HUD：

- 胶囊里是 CPU 与内存占用，各一条细进度条；每 **10 秒**刷新一次
- 鼠标悬停（或键盘聚焦）在胶囊上，上方展开卡片，列出 **CPU 与内存各自占用最高的 5 个进程**
- 60% 转黄、85% 转红；读数丢失时保留上一次数字，只在卡片标题旁点一个红点

不修改 asar 里的任何文件，只用公开扩展点：Client 半注册到 `shell.overlay`，
Host 半注册两条同源路由。

## 为什么放在浮层，而不是侧栏底部

侧栏底部已经有「设置」按钮，且侧栏列是 `overflow:hidden`——把悬停卡片放进侧栏，
卡片会被裁掉。`shell.overlay` 是官方为 badge / 状态条 / toast 准备的**框架级浮层**：
位于所有列之上、在滚动容器之外，并且默认 `pointer-events:none`（每个条目自己开
`pointer-events:auto`）。插件把胶囊定位在 `left:12px; bottom:54px`，正好在侧栏页脚
上方，不挡「设置」。

条目占一个 436px 宽的浮层方块；卡片收起时只有胶囊大小，移出即关。

## 数据从哪来

| 数据 | 来源 | 频率 |
|---|---|---|
| 系统 CPU | `node:os` 的 `cpus()` 累计时间 | 每次轮询 |
| 内存 | `os.totalmem()` / `os.freemem()` | 每次轮询 |
| 进程 CPU / 内存 | Windows：常驻 PowerShell 采样器；其它平台：`ps` | 悬停时每 10 秒一次 |

### Windows：为什么要养一个常驻 PowerShell

本机每次创建 `pwsh` 进程大约要 **2–3 秒**（安全软件会扫描进程创建），
按需 spawn 会让第一次悬停先等好几秒。所以 Host 半在页面第一次请求指标时
拉起一个常驻 PowerShell，用 stdin 发 `S`、stdout 回一行 JSON：

```text
READY
S
SYSMON {"cores":8,"sampleMs":700,"processes":429,"cpu":[...],"mem":[...]}
```

- 采样窗口 700ms：前后各读一次 `Get-Process` 的 `CPU`（累计处理器秒），
  差值是这一瞬间的占用；除以逻辑核数后就是「占整机」的百分比，和任务管理器同口径
- 采样器自己（`$PID`）从榜单里排除
- 空闲 3 分钟没人看进程就杀掉，下次悬停再启动；页面加载时先暖一次，
  让第一次悬停不用等冷启动
- 采样失败/输出坏行时丢弃这一份，路由返回 `available:false`，页面显示
  「正在采样…」并 2 秒后重试；启动失败会冷却 60 秒，避免反复拉起坏进程

之所以不每次悬停都 spawn：常驻进程空闲时阻塞在 `ReadLine()` 上，不耗 CPU；
采样一次约 0.9 秒（含 700ms 窗口），只在面板打开时发生。

### macOS / Linux

用 `ps -eo pid=,pcpu=,rss=,comm=` 一次取样，没有常驻进程。
注意 `ps` 的 `pcpu` 是**进程生命周期均值**，不是瞬时值；接口里用
`cpuMode: "lifetime"` 标出来，卡片底部会显示一句说明。

### 口径与隐私

- 进程内存是 `WorkingSet64`（工作集）；`Memory Compression` 这类系统进程的数值
  会明显偏大，属正常现象
- 只读进程名（`ProcessName`），**不读命令行**，不会把路径、密钥或参数带出来
- 所有数值在 Host 半做范围清洗：CPU 夹到 0–100，内存取非负值，名称截到 80 字符

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sysmon/metrics` | `{ ok, ts, cpu:{percent,cores,windowMs,model}, mem:{total,used,free,percent}, uptimeSec }` |
| GET | `/sysmon/processes` | `{ ok, available, cached, ageMs, sampledAt, cpuMode, cores, processCount, cpu:[…5], mem:[…5] }` |

两条都是同源路由，启动时用 `ctx.get('connection').requestRejection(req)` 做与官方
页面一致的鉴权围栏；只接受 GET（其它方法 405），响应 `cache-control: no-store`。

## 安装

在 DSH 里通过插件管理器安装本目录即可（`plugin_manager` / 设置 → 插件）。
`desktop` profile 被 Electron 独占时，也可以按本仓库的手工流程接入：

### A. 热加载（不用重启宿主）

1. `$DSH_HOME/profiles/desktop/package.json` 的 `dependencies` 加
   `"@local/dsh-sysmon": "link:<repo>/dsh-sysmon"`，在 profile 目录跑 `pnpm install`。
2. 在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 末尾加：

   ```yaml
   - insert:
       - id: sysmon
         name: '@local/dsh-sysmon'
   ```

3. `patchReload: live` 会加载 Host 行；**刷新一次页面**即可看到 Client 半。

### B. 正式收进 bundle（需要重启）

1. 同样先加 `dependencies` 并 `pnpm install`。
2. 把 `@local/dsh-sysmon` 追加到 `dsh.profile.bundles`，由本包的
   `cordis.patch.yml` 自动插入 Host 行。
3. 删掉 A 里的 `- insert:` 块，避免同一个包插入两次。
4. 重启 DSH Desktop。

装好后左下角立刻出现胶囊；若显示 `—`，等第一轮指标请求完成（约 1 秒）。
第一次悬停如果正好赶上采样器冷启动，会先显示「正在采样进程…」，约 2–4 秒后出榜。

## 验证

```powershell
node dsh-sysmon\smoke.mjs
```

通过时打印 `ALL PASS`。脚本会：

- 校验清单、中英语言文件、patch、图标
- 真跑 Host 的 `apply`，直调两条路由：CPU/内存范围、采样窗口、进程榜 5 条与降序、
  只含 `pid/name/cpu/mem` 四个字段、405、缓存复用
- 用极简 React（支持 deps 与 cleanup）渲染 Client：胶囊读数、悬停展开、
  两张榜各 5 行、GB/MB 格式化、页脚、收起、定时器清理
- 样式护栏：无硬编码颜色、`var()` 只引用 `--dsw-alias-*` / `--dsw-specific-*` /
  `--ds-font-*`、类名全部 `dshts-` 前缀

## 已知限制

- **Windows 依赖 PowerShell**：优先 PowerShell 7，其次 Windows PowerShell 5.1。
  两者都没有时进程榜返回不可用，胶囊仍能显示系统 CPU/内存。
- **进程 CPU 是 700ms 窗口的瞬时值**：榜单会随采样时刻抖动；想看稳定占用看多次刷新。
- **受保护进程可能读不到**：以更高权限运行的进程在 `Get-Process` 里可能没有
  `CPU`/工作集，榜单里会缺；不会报错。
- **采样器本身不占榜**：`$PID` 被排除，所以榜单里不会出现那个 PowerShell。
- **左下角是固定位置**：不跟随侧栏展开/折叠或窗口缩放重排；侧栏页脚之外的内容
  （会话列表底部）在悬停卡片展开时会被暂时盖住。
- **macOS / Linux 的 CPU 口径不同**：`ps` 给的是生命周期均值，卡片底部会标注。
- **每 10 秒是页面侧的节奏**：浏览器标签页被系统节流时可能更慢；重新可见时会立即补一次。
