# dsh-plugins

DSH（DeepSeek Harness）插件集合。每个插件都是独立的 npm 包，只使用官方公开的扩展点，
不修改 asar 里的任何官方代码。

| 插件 | 作用 | 入口 |
|---|---|---|
| [dsh-theme-colors](dsh-theme-colors) | 用取色器自定义深色模式配色，内置 7 套预设，改动立即生效 | 设置 → 外观颜色 |
| [dsh-token-usage](dsh-token-usage) | 累计记录每次模型调用的 token 用量（全局 / 按模型 / 按天），可设置单价估算费用 | 设置 → Token 统计 |
| dsh-git | （占位，待补充说明） | — |

## 安装

`desktop` profile 被 Electron 应用独占，CLI 会直接拒绝：

```
> dsh --profile desktop plugin add ...
error: profile "desktop" is managed exclusively by the Electron application
```

所以走插件管理器本来就会做的那几步：

1. 把包软链进 profile：`profiles/desktop/node_modules/@local/<包名>`
2. 在 `profiles/desktop/package.json` 的 `dependencies` 里加 `link:` 记录，
   并把 `@local/<包名>` 追加到 `dsh.profile.bundles`
3. 在 `profiles/desktop` 里跑一次 `pnpm install`
4. 重启 DSH Desktop（依赖字段的改动不触发热重载）

每个包自带的 `cordis.patch.yml` 会把对应的插件行插进插件树。

## 结构

每个插件目录的布局一致：

```
index.js          Host 半（有 Host 逻辑的插件才需要，theme-colors 只用来占一行）
client.js         Client 半：设置页 UI
cordis.patch.yml  bundle 的 patch 层
icon.svg          插件图标
locale/*.json     插件列表里显示的标题与描述
package.json      含 dsh.bundle.patch / dsh.client 声明
smoke.mjs         自检脚本（不启动浏览器、不连 DSH）
README.md         该插件的详细说明
```

## 自检

各插件目录下运行：

```powershell
node dsh-theme-colors\smoke.mjs
node dsh-token-usage\smoke.mjs
```

用极简 React 在 Node 里跑一遍注册契约、状态清洗与渲染，全 PASS 才算接线正确。

## 许可

[MIT](LICENSE)
