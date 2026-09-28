# dsh-token-usage

累计记录 Harness 里每次模型调用的 token 用量，并在 **设置 → Token 统计** 里查看。

## 统计口径

- 数据来源：Host 半监听 `llm/stream`（每次流式模型调用都会经过的 waterfall），
  读取 adapter 上报的 `usage` chunk。同一路流里出现多个 usage chunk 时只取最后一个
  （与 agent-loop 的 `BlockAssembler` 一致）。
- 维度：全局合计、按 `provider/model`、按本地自然日。
- 字段：调用次数、输入、输出、缓存命中（cache read）、缓存写入（cache write）、
  推理（reasoning，通常已含在输出里，因此不计入总量）、合计。
- 子代理、workflow 子任务、压缩与会话标题等内部调用都会计入；`countInternalCalls: false`
  可以排除带 `purpose` 的内部调用。

## 落盘

默认 `$DSH_HOME/token-usage/usage.json`（Windows 即 `C:\Users\<你>\.dsh\token-usage\usage.json`），
写入防抖 2 秒，插件卸载时补写一次。文件损坏时从零开始，不影响 Host 启动。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/token-usage/stats` | 返回累计统计（设置页读取） |
| POST | `/token-usage/reset` | 清零累计统计 |

两条路由都会先过 `connection.requestRejection`（Host/Origin 围栏 + 浏览器认证）。

## 配置（profile 的 `cordis.patch.yml`）

```yaml
- id: token-usage
  config:
    persistPath: D:\data\dsh\usage.json
    countInternalCalls: true
    flushDelayMs: 2000
```
