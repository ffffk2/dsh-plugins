# dsh-theme-colors

给 DSH 一个自己选颜色的入口：**设置 → 外观颜色**，用取色器调整深色模式的关键配色，改动立即生效。

## 为什么需要它

内置的 `@deepseek-ai/dsh-client-ui-theme` 只提供 `浅色 / 深色 / 跟随系统` 与正文字号，
深色模式的底色是写死的（主背景 `#151517`、侧栏 `#1b1b1c`、卡片 `#232324` / `#2c2c2e`），
没有自定义入口。本插件用官方公开的扩展点补上这一层，不修改 asar 里的任何官方代码。

## 能改什么

| 分组 | token | 深色默认值 |
|---|---|---|
| 背景与表面 | `--dsw-alias-bg-base` 主背景 | `#151517` |
| | `--dsw-specific-sidebar-fill` 侧边栏 | `#1b1b1c` |
| | `--dsw-alias-bg-layer-1` 一级表面 | `#232324` |
| | `--dsw-alias-bg-layer-2` 二级表面（卡片） | `#2c2c2e` |
| | `--dsw-alias-bg-overlay` 浮层底色 | `#43454a` |
| 文字 | `--dsw-alias-label-primary` 正文 | `#f9fafb` |
| | `--dsw-alias-label-secondary` 次要文字 | `#cfd3d6` |
| 强调色 | `--dsw-alias-brand-primary` 品牌强调 | `#f9fafb` |
| | `--dsw-alias-state-business-primary` 链接与焦点 | `#7aaaff` |
| 分隔线 | `--dsw-alias-border-l1` 细边框 | `#ffffff0f` |
| | `--dsw-alias-border-l2` 粗边框 | `#ffffff1f` |

取值支持 `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` / `hsl()` / `hsla()`，
边框那两行用 8 位十六进制（末两位是透明度）。

## 预设配色（低调护眼向）

设置页顶部有 7 张预设卡片，**点一下整套生效**（每套覆盖全部 11 个 token，不会残留上一套的颜色），
之后还能按行微调；只要有一行被改过，预设高亮就会消失。

| 预设 | 来源 | 主背景 | 正文/底 | 链接/底 |
|---|---|---|---|---|
| 暖灰护眼 | 自研 | `#1e1c1a` | 10.56 | 6.53 |
| 深蓝夜 | 自研 | `#131820` | 11.41 | 7.03 |
| 常青 Everforest | [Everforest](https://github.com/sainnhe/everforest) | `#2d353b` | 7.38 | 5.74 |
| 格鲁布 Gruvbox | [Gruvbox](https://github.com/morhetz/gruvbox) Soft | `#2b2927` | 10.56 | 5.38 |
| 北境 Nord | [Nord](https://www.nordtheme.com/) | `#2e3440` | 9.25 | 6.24 |
| 日光 Solarized | [Solarized](https://ethanschoonover.com/solarized/) Dark | `#002b36` | 7.90 | 5.18 |
| 摩卡 Catppuccin | [Catppuccin](https://catppuccin.com/) Mocha | `#1e1e2e` | 10.54 | 7.79 |

对比度是 WCAG 相对亮度算出来的，护眼区间取的是：**正文/底 7–13**（够读但不刺白）、
次要文字/底 ≥ 4.5、**链接/底 4.5–9**（能读但不霓虹）、正文/卡片 ≥ 5、
品牌色与按钮上的反色字 ≥ 4.5。东方/西方两套官方配色都按这个区间做了微调：
Solarized 的 `#268bd2` 链接色在原底上只有 4.08，所以提到 `#3f9fe0`（5.18）；
正文也从 base1 提亮到 `#b0bfbf`，否则落在 6.9 偏暗。Everforest、Gruvbox 都是原生值。

配色总览图：[preview-palettes.png](preview-palettes.png)（Pillow 画的模拟界面）。

## 生效与持久化

- **生效**：调用主题服务的公开扩展点 `ctx.theme.overrideTokens(source, { token: { light, dark } })`。
  `ui-layout` 会把快照里的 token 直接 `setProperty` 到 `body` 上，所以选色是即时的——设置页本身就会跟着变色。
- **持久化**：`localStorage`（key `dsh-theme-colors/v1`）。DSH Desktop 固定监听 `127.0.0.1:19387`，
  origin 稳定，因此跨重启有效。
- **浅色模式不受影响**：覆盖层只改 `dark` 一侧，`light` 一侧固定带官方原值；
  某一行没被改过时根本不进覆盖层。
- 顶部的「启用自定义配色」可以整体开关，「全部恢复默认」清空所有改动。
  总开关关掉时预设卡片仍然可点，点一下会自动重新打开。

## 结构

```
index.js          Host 半：只为在 profile 组合里占一行（Client 模块是从 Host Loader 条目扫描出来的）
client.js         Client 半：设置页 + 7 套预设 + 取色器 + token 覆盖（window.__ModuleLoader__.load 手写 bundle）
cordis.patch.yml  bundle 的 patch 层：插入 theme-colors 行
locale/*.json     插件列表里显示的标题/描述
smoke.mjs         自检（含预设的对比度断言）
preview-palettes.png  7 套预设的对比预览图（脚本另存，不参与运行）
```

## 安装 / 卸载

`desktop` profile 被 Electron 应用独占，CLI 会直接拒绝：

```
> dsh --profile desktop plugin add ...
error: profile "desktop" is managed exclusively by the Electron application
```

所以安装走的是插件管理器本来就会做的那几步（等价于侧边栏「插件」页里的安装操作）：

1. 本包软链进 profile：`profiles/desktop/node_modules/@local/dsh-theme-colors`
2. `profiles/desktop/package.json`：`dependencies` 加 `link:` 记录，
   `dsh.profile.bundles` 追加 `@local/dsh-theme-colors`（组合包自带的
   `cordis.patch.yml` 会把 `theme-colors` 行插进插件树）
3. 在 `profiles/desktop` 里跑一次 `pnpm install`，让锁文件与 node_modules 对齐
4. **重启 DSH Desktop**——依赖字段的改动不会触发热重载，插件管理器安装时
   会自己触发组合刷新，手工改动则需要重启

卸载就是把第 1、2 步反过来，再跑一次 `pnpm install`。

## 自检

```powershell
node "$env:USERPROFILE\.dsh-plugins\dsh-theme-colors\smoke.mjs"
```

用极简 React 在 Node 里跑一遍注册契约、状态清洗、token 覆盖写入、预设套用与设置页渲染，
共 46 项断言（含每套预设的 11-token 完整性与对比度区间），全 PASS 才算接线正确。
它不启动浏览器，也不连 DSH。
