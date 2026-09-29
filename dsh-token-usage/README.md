# dsh-token-usage

累计记录 Harness 里每次模型调用的 token 用量，并在 **设置 → Token 统计** 里查看。
填好模型单价后，页面会按累计量估算费用。

## 统计口径

- 数据来源：Host 半监听 `llm/stream`（每次流式模型调用都会经过的 waterfall），
  读取 adapter 上报的 `usage` chunk。同一路流里出现多个 usage chunk 时只取最后一个
  （与 agent-loop 的 `BlockAssembler` 一致）。
- 维度：全局合计、按 `provider/model`、按本地自然日。
- 字段：调用次数、输入、输出、缓存命中（cache read）、缓存写入（cache write）、
  推理（reasoning，通常已含在输出里，因此不计入总量）、合计。
- 子代理、workflow 子任务、压缩与会话标题等内部调用都会计入；`countInternalCalls: false`
  可以排除带 `purpose` 的内部调用。

## 费用计算

在设置页 **模型单价** 卡里给每个模型填四个单价（人民币元 / 百万 token）：

| 计费项 | 对应计数器 | 说明 |
|---|---|---|
| 输入 | `inputTokens` | 未命中缓存的提示 token |
| 输出 | `outputTokens` | 补全 token（含推理） |
| 缓存命中 | `cacheReadTokens` | 命中缓存的提示 token |
| 缓存写入 | `cacheWriteTokens` | 写入缓存的 token |

- 四项**各算各的、互不重叠**：`inputTokens` 不含缓存读写。依据是官方 chat UI 也用
  `totalTokens - outputTokens` 还原 prompt 总量、再减去 `cacheReadTokens` 得到未命中缓存的输入；
  本机累计数据里 `cacheRead` 长期远大于 `inputTokens`，若含则不可能。
- `reasoningTokens` 已含在 `outputTokens` 里，不单独计费。
- 只填部分单价时，缺的项按 0 计，并在页面上标 `*`（单价不全），不会按 0 元静默少算成「免费」以外的误导数字。
- 没有单价的模型不计入总费用，页面上单独列出「未定价：…」，避免把未知当成 0。
- 金额按 6 位小数四舍五入；小于 0.01 元时页面显示 4 位小数。

单价是用户的配置，**`POST /token-usage/reset` 清零累计时不会清除单价**。

## 落盘

默认 `$DSH_HOME/token-usage/usage.json`（Windows 即 `C:\Users\<你>\.dsh\token-usage\usage.json`），
写入防抖 2 秒，插件卸载时补写一次。文件损坏时从零开始，不影响 Host 启动。
单价与累计存在同一个文件里（`prices` / `pricesUpdatedAt` 字段）。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/token-usage/stats` | 返回累计统计与费用（设置页读取） |
| POST | `/token-usage/reset` | 清零累计统计（保留单价） |
| GET | `/token-usage/prices` | 读取单价表（等同 stats） |
| POST | `/token-usage/prices` | 覆盖单价表，body 形如 `{"prices": {"<provider>/<model>": {"input": 2, "output": 8}}}` |

四条路由都会先过 `connection.requestRejection`（Host/Origin 围栏 + 浏览器认证）。
单价写入会清洗非法值（负数、非数字、空键、多余字段一律丢弃），请求体上限 256KB。

## 数据安全

历史版本在读到损坏的 `usage.json` 时会静默从零开始，用户只会发现数据莫名消失却查不到原因。
现在按「尽量不丢、丢了可查、查了能救」做了兜底：

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
- 启动时若配置的 `persistPath` 与默认路径 `$DSH_HOME/token-usage/usage.json` **两份并存**，
  会 warn 提示——这种「两个文件各记各的」很容易被误判成数据丢失；
- 恢复/损坏/清零快照只在该出现时于页面底部提示一行，平时不占地方。

想手工回到某个历史点：把 `usage.json.snapshot-<时间戳>` 复制成 `usage.json` 再重启即可
（快照就是完整的 state 文件，含单价）。

## 改完代码为什么要重启

Host 半（`index.js`）是 Node 模块，**Node 会缓存已导入的模块——改了文件不会重新导入**。
profile 里的 `patchReload: live` 只让 **patch YAML（配置）** 即时生效，不覆盖这一层。
所以改了 `index.js` 必须**完全退出并重启 DSH Desktop**；只改 Client 半（`client.js`）刷新页面即可。

为了不再靠人记，插件会自己比对「磁盘上的 `index.js` 修改时间」与「模块加载时间」：

- 启动时若已经落后，打一条 warn 日志；
- 页面顶部显示一条**醒目横幅**说明当前跑的是旧代码、需要重启；
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

单价不走这里：它在设置页里编辑，改完立即生效，不需要重启 DSH。
