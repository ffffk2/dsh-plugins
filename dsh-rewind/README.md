# dsh-rewind —— 对话回滚

给 DeepSeek Harness 补上「回到我发过的某条消息」：把**模型可见的上下文**与**工作区文件**
一起撤回那一刻，之后可以重新提问、重新改。

> 和官方「新会话 / fork」不同：它发生在**当前会话里**，会话 id、标题、历史都不变。

## 它做了什么

每条**真人消息**（从界面发出、带 `rpcId` 的那种）落地时，插件会给工作区拍一份快照。
之后在输入框上方的「回滚对话」面板里点任意一条消息 → 确认，插件做两件事：

| 动作 | 结果 |
|---|---|
| 上下文截断 | 该消息之后的全部对话（含工具调用与结果）不再进入模型上下文 |
| 文件还原 | 工作区回到这条消息刚发出时的样子：改过的写回、新建的删掉、删掉的找回 |

面板同时在收起态显示当前回滚点，并提供**撤销文件回滚**（把文件恢复到回滚前的样子）。
上下文截断本身**不可撤销** —— 被撤回的消息仍留在会话日志与轨迹视图里，只是不再进入上下文。

## 原理

### 上下文：复用官方的「表面区段替换」

会话日志是 append-only 的，模型看到的则是它上面的一层**表面**（surface）。官方压缩
（compaction）就是往日志里追加一条新事件、声明它**替换**掉表面上一段旧节点：

```js
session.append('user/message', replacement, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: shadowedSeqs,
})
```

本插件用的是同一机制，只是替换节点是一条**内容为空的 user 消息**：

* 表面上的位置被占住，日志保持 append-only，可持久化、可重放；
* 空的 user 消息不携带任何内容 —— DeepSeek 适配器会直接跳过它
  （`if (message.role === "user" && content.length === 0) continue`），
  于是模型上下文恰好停在回滚点之前，既没有多余 token，也没有伪造的文本。

如果你用的适配器不过滤空 user 消息，把 `keepMessage` 设为 `true`：替换节点会携带
该消息的原文，上下文变成「这条消息刚发出」的那一刻（同样没有多余文本）。

原始事件全部保留在日志里，`session/event` 会把这次替换推给浏览器，界面不需要额外刷新。

### 文件：内容寻址快照

纯 `node:*` 实现，不依赖 git：

* 每条真人消息落地时遍历工作区（默认跳过 `node_modules`、`.git`、`dist` 等目录，
  单文件默认 2 MiB 上限），把每个文件的 sha1 与相对路径写进清单；
* 文件内容按 sha1 存进 `blobs/`，同一份内容（跨文件、跨快照）只存一次；
* 回滚时按清单比对：内容变了的写回、清单里没有的删掉、缺了的重建；
* 还原前先给「现在」拍一份安全快照，所以文件回滚可以撤销。

`stat` 一致就跳过哈希、不一致才比 sha1，因此回滚一次通常只读改动过的那几个文件。

## 安装

本包和其他 `@local/*` 插件一样，通过 profile 的 bundle patch 行装载：

```jsonc
// profiles/<名>/package.json
{
  "dependencies": { "@local/dsh-rewind": "link:<本仓库>/dsh-rewind" },
  "dsh": { "profile": { "bundles": ["@local/dsh-rewind"] } }
}
```

然后在 profile 目录里 `pnpm install` 并重启 Harness。若 profile 开启了
`patchReload: "live"`，也可以直接把行写进 `profiles/<名>/cordis.patch.yml`：

```yaml
- insert:
    - id: rewind
      name: '@local/dsh-rewind'
      config:
        restoreFiles: true
        keepMessage: false
        maxPoints: 40
```

## 配置

`cordis.patch.yml` 里的 `config` 是裸 JSON（本插件不导出 Config schema），Host 半自己兜默认值：

| 键 | 默认值 | 说明 |
|---|---|---|
| `root` | `$DSH_HOME/rewind` | 快照落盘根目录（`blobs/` 与 `sessions/<会话 id>/`） |
| `restoreFiles` | `true` | 回滚时是否同时还原工作区文件 |
| `keepMessage` | `false` | `false` 撤回该消息本身；`true` 让上下文停在「这条消息刚发出」 |
| `maxPoints` | `40` | 每个会话保留多少个回滚点（超出丢弃最旧的） |
| `maxFileBytes` | `2097152` | 单文件入快照的大小上限 |
| `maxFiles` | `20000` | 单次快照最多收录的文件数 |
| `maxSnapshotBytes` | `268435456` | 单次快照最多收录的字节数 |
| `ignoreDirs` | 见 `index.js` | 快照不覆盖的目录名（这些路径不会被回滚改动） |

文件数或体积触顶时，快照标记为不完整：**只还原、不删除**，避免误删没被记录的文件。

## 边界

* **只回滚工作区（会话的 `cwd`）**：写到工作区之外的文件（临时目录、其它盘）不参与回滚。
* **忽略目录不参与**：`node_modules`、`.git`、构建产物等默认被跳过（可用 `ignoreDirs` 调整）。
* **超大文件不参与**：超过 `maxFileBytes` 的文件只被计数，不会被还原。
* **回合进行中不能回滚**：请先停止当前回合（面板会提示）。
* **子代理会话不拍快照**：回滚只面向你在界面上直接对话的会话。
* **上下文回滚不可逆**：表面替换没有反向操作，被撤回的消息无法重新进入上下文。

## 开发

```powershell
node dsh-rewind\smoke.mjs      # 在 git 仓库根目录跑；退出码 0 即全部通过
```

烟测不启动 Harness：Host 半用假 ctx + 假 session 真跑一遍
「拍快照 → 改文件 → 回滚 → 撤销文件回滚」并断言表面替换参数与文件结果；
Client 半用极简 React 真渲染面板，拿上一步真实的 `points` 负载断言行、确认区与请求体。
