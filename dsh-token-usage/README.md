# dsh-token-usage

在 **设置 → Token 统计** 里看模型 token 用量。页面结构对齐 ZCode（`zai-org/ZCode`）开源版的
「设置 → Usage」，只保留本地统计与图表，不再做费用估算。

## 页面

| 区块 | 内容 |
|---|---|
| 指标条 | 累计 Token 数、峰值 Token 数、最长会话、当前连续天数、最长连续天数 |
| Token 活动 | 最近 52 个自然周的热力图，可切「每日 / 每周 / 累计」三种口径，悬停看当天 Token 与调用次数 |
| 时间范围 | 近 7 日 / 近 30 日（作用于下面两张图） |
| 每日趋势 | 按天画用量最高的 6 个模型的折线；悬停显示当天总量与各模型明细 |
| 模型用量 | 环形图 + 明细列表：占比与 Token 数；超过 6 个模型时合并为「其他模型」 |

底部是刷新、清零，以及数据文件与兜底提示（损坏留证 / 快照恢复 / 清零快照只在该出现时占一行）。

## 统计口径

- 数据来源：Host 半监听 `llm/stream`（每次流式模型调用都会经过的 waterfall），读取 adapter
  上报的 `usage` chunk。同一路流里出现多个 usage chunk 时只取最后一个（与 agent-loop 的
  `BlockAssembler` 一致）。
- 记录四个维度：
  - `totals`：全局合计；
  - `models`：按 `provider/model`；
  - `days`：按本地自然日，天内再按 `provider/model` 分层（趋势图与环形图要用）；
  - `sessions`：按 `sessionId` 记首次/末次调用时间与调用次数，用于「最长会话」。
- 字段：调用次数、输入、输出、缓存命中（cache read）、缓存写入（cache write）、推理
  （reasoning，通常已含在输出里，因此不计入总量）、合计。
- 缓存命中率 = `cacheRead / (cacheRead + input)`，与旧版页面一致。
- 连续天数按本地自然日计算：今天还没用时从昨天往前数；切到「近 7 日」不会把已经攒下的
  30 天连续记录改小（连续天数始终按全部历史算）。
- 最长会话是单调递增的高水位，跨范围不变；会话表只保留最近 500 个，但高水位不会因此回退。
- 子代理、workflow 子任务、压缩与会话标题等内部调用都会计入；`countInternalCalls: false`
  可以排除带 `purpose` 的内部调用。

## 历史数据兼容

`why`：v2 之前只按天记总量，没有「天内按模型」这一层。直接当缺失处理，升级后的趋势图会
凭空少掉前几天的数据，看起来像统计坏了。

现在读取 v1 文件时照常保留总量，把「当天总量 − 已知模型之和」的差额聚合为伪模型
**未分模型**（key `__other__`）：

- `all` 视图用终身模型表，不产生「未分模型」；
- `7d` / `30d` 视图里，升级前的日子会整段落进「未分模型」，总量与指标条仍然对得上；
- 升级后新产生的调用会正常进入按模型明细，伪模型随之消失。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/token-usage/stats?range=7d\|30d\|all` | 某个范围的统计快照；非法 range 回落到 `all` |
| POST | `/token-usage/reset` | 清零累计统计（清零前自动留快照） |

两条路由都会先过 `connection.requestRejection`（Host/Origin 围栏 + 浏览器认证）。
请求体不再有单价，`/token-usage/prices` 已随费用功能一起移除。

## 落盘

默认 `$DSH_HOME/token-usage/usage.json`（Windows 即 `C:\Users\<你>\.dsh\token-usage\usage.json`），
写入防抖 2 秒，插件卸载时补写一次。文件损坏时从快照恢复，不影响 Host 启动。

## 数据安全

**写盘**

- `写 tmp → fsync 文件 → rename → fsync 目录`。只做 rename 是不够的：它只保证文件名
  替换是原子的，不保证数据已落盘，掉电会留下 0 字节或半截的目标文件——这是「重启后统计没了」
  最典型的成因。目录 fsync 在不支持的平台上忽略。
- 每 20 次落盘额外留一份 `usage.json.snapshot-<时间戳>`，最多保留 5 份（只增量快照，
  不会反复写同一份内容把有用的旧快照挤掉）。

**读盘（按优先级）**

1. 主文件正常 → 直接用；
2. 主文件损坏（空文件、半截 JSON、`null`、数组、别的用途的 JSON 都算）→ 先改名成
   `usage.json.corrupt-<时间戳>` 留证，**再从最近的快照恢复**，而不是从零开始；
3. 主文件被误删 → 有快照就从快照恢复；
4. 都没有 → 才从零开始。

**其他**

- **清零可悔**：点击「清零」前会强制写一份快照，手滑了能从快照捞回来，页面会给出快照路径；
- 启动时若配置的 `persistPath` 与默认路径两份并存，会 warn 提示；
- 想手工回到某个历史点：把 `usage.json.snapshot-<时间戳>` 复制成 `usage.json` 再重启即可
  （快照就是完整的 state 文件）。

## 改完代码为什么要重启

Host 半（`index.js`）是 Node 模块，**Node 会缓存已导入的模块——改了文件不会重新导入**。
profile 里的 `patchReload: live` 只让 **patch YAML（配置）** 即时生效，不覆盖这一层。
所以改了 `index.js` 必须**完全退出并重启 DSH Desktop**；只改 Client 半（`client.js`）刷新页面即可。

为了不再靠人记，插件会自己比对「磁盘上的 `index.js` 修改时间」与「模块加载时间」：

- 启动时若已经落后，打一条 warn 日志；
- 页面顶部显示**醒目横幅**说明当前跑的是旧代码、需要重启；
- `GET /token-usage/stats` 里带回 `build`（代码版本号）与 `staleSince`，便于脚本排查。

⚠️ **每次修改 `index.js` 都要把文件顶部的 `HOST_BUILD` 加一**，否则无法从页面区分新旧。

## 配置（profile 的 `cordis.patch.yml`）

```yaml
- id: token-usage
  config:
    persistPath: D:\data\dsh\usage.json
    countInternalCalls: true
    flushDelayMs: 2000
```

## 从 1.x 升级

- 费用功能（单价表、费用卡、`/token-usage/prices`）已移除；旧文件里的 `prices` 字段会被忽略，
  下次落盘时自然消失。
- 数据文件版本变为 `2`：新增 `days[*].models`、`sessions`、`longestSessionMs`。v1 文件可直接读取。
