# dsh-theme-colors

给 DSH 一个自己选颜色的入口：**设置 → 外观颜色**，用取色器调整深色与浅色两套关键配色，改动立即生效。

## 为什么需要它

内置的 `@deepseek-ai/dsh-client-ui-theme` 只提供 `浅色 / 深色 / 跟随系统` 与正文字号，
两套配色的底色都是写死的（深色主背景 `#151517`、侧栏 `#1b1b1c`、卡片 `#232324` / `#2c2c2e`；
浅色则是纯白 `#ffffff` + 深灰字，对比度 18.9:1），没有自定义入口。
本插件用官方公开的扩展点补上这一层，不修改 asar 里的任何官方代码。

## 能改什么

11 个 token，**深色与浅色各存一份**：

| 分组 | token | 深色默认值 | 浅色默认值 |
|---|---|---|---|
| 背景与表面 | `--dsw-alias-bg-base` 主背景 | `#151517` | `#ffffff` |
| | `--dsw-specific-sidebar-fill` 侧边栏 | `#1b1b1c` | `#f9fafb` |
| | `--dsw-alias-bg-layer-1` 一级表面 | `#232324` | `#ffffff` |
| | `--dsw-alias-bg-layer-2` 二级表面（卡片） | `#2c2c2e` | `#ffffff` |
| | `--dsw-alias-bg-overlay` 浮层底色 | `#43454a` | `#e9ecf2` |
| 文字 | `--dsw-alias-label-primary` 正文 | `#f9fafb` | `#0f1115` |
| | `--dsw-alias-label-secondary` 次要文字 | `#cfd3d6` | `#61666b` |
| 强调色 | `--dsw-alias-brand-primary` 品牌强调 | `#f9fafb` | `#0f1115` |
| | `--dsw-alias-state-business-primary` 链接与焦点 | `#7aaaff` | `#4176e6` |
| 分隔线 | `--dsw-alias-border-l1` 细边框 | `#ffffff0f` | `#0000000a` |
| | `--dsw-alias-border-l2` 粗边框 | `#ffffff1f` | `#0000001a` |

取值支持 `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` / `hsl()` / `hsla()`，
边框那两行用 8 位十六进制（末两位是透明度）。

### 深 / 浅两侧互不干扰

设置页顶部是 `深色 / 浅色` 两个页签，**打开时默认停在当前正在生效的那一套**（跟随主题偏好，
主题切成浅色页签就跟着跳）。两边各存自己的 11 个 token：

- 只改深色，浅色就一直是官方值；反之亦然——覆盖层里每个 token 带的是一对
  `{ light, dark }`，运行时按当前 `colorScheme` 取用对应那一侧。
- 页签上的数字气泡是「这一侧改了几项」，某一侧没被改过就没有气泡。
- 手动点过页签之后就不再自动跟随（否则每次切主题都会跳走）；点回当前生效的那一侧即恢复跟随。

## 预设配色（低调护眼向）

每侧各有一排预设卡片，**点一下整套生效**（每套覆盖该侧全部 11 个 token，不会残留上一套的颜色，
另一侧完全不受影响），之后还能按行微调；只要有一行被改过，预设高亮就会消失。

深色侧 7 套：

| 预设 | 来源 | 主背景 | 正文/底 | 链接/底 |
|---|---|---|---|---|
| 暖灰护眼 | 自研 | `#1e1c1a` | 10.56 | 6.53 |
| 深蓝夜 | 自研 | `#131820` | 11.41 | 7.03 |
| 常青 Everforest | [Everforest](https://github.com/sainnhe/everforest) | `#2d353b` | 7.38 | 5.74 |
| 格鲁布 Gruvbox | [Gruvbox](https://github.com/morhetz/gruvbox) Soft | `#2b2927` | 10.56 | 5.38 |
| 北境 Nord | [Nord](https://www.nordtheme.com/) | `#2e3440` | 9.25 | 6.24 |
| 日光 Solarized | [Solarized](https://ethanschoonover.com/solarized/) Dark | `#002b36` | 7.90 | 5.18 |
| 摩卡 Catppuccin | [Catppuccin](https://catppuccin.com/) Mocha | `#1e1e2e` | 10.54 | 7.79 |

浅色侧 8 套（**底色一律不用纯白**，亮度压在 0.92 以内，把官方 18.9:1 的硬对比降到 7–13）：

| 预设 | 来源 | 主背景 | 正文/底 | 次要/底 | 链接/底 |
|---|---|---|---|---|---|
| 豆沙绿 | 经典护眼绿 | `#c7e5cd` | 9.27 | 4.96 | 4.83 |
| 米白护眼 | 自研 | `#f4edde` | 10.45 | 5.09 | 5.60 |
| 雾青 | 自研 | `#eef1f4` | 11.27 | 5.14 | 4.91 |
| 常青 Everforest Light | [Everforest](https://github.com/sainnhe/everforest) | `#f8f1dc` | 7.03 | 4.78 | 5.00 |
| 格鲁布 Gruvbox Light | [Gruvbox](https://github.com/morhetz/gruvbox) | `#fbf1c7` | 10.22 | 5.74 | 5.82 |
| 北境 Nord Light | [Nord](https://www.nordtheme.com/) | `#eceff4` | 10.84 | 6.40 | 5.56 |
| 日光 Solarized Light | [Solarized](https://ethanschoonover.com/solarized/) | `#f7efda` | 7.57 | 4.59 | 4.78 |
| 摩卡 Catppuccin Latte | [Catppuccin](https://catppuccin.com/) Latte | `#eff1f5` | 7.06 | 4.99 | 5.00 |

对比度是 WCAG 相对亮度算出来的，护眼区间取的是：**正文/底 7–13**（够读但不刺白）、
次要文字/底 ≥ 4.5、**链接/底 4.5–9**（能读但不霓虹）、正文/卡片 ≥ 5、
品牌色与按钮上的反色字 ≥ 4.5（深色侧是亮底 + 深字，浅色侧是深底 + 白字）。
东方/西方两套官方配色都按这个区间做了微调：
Solarized 深色的 `#268bd2` 链接色在原底上只有 4.08，所以提到 `#3f9fe0`（5.18），
正文也从 base1 提亮到 `#b0bfbf`，否则落在 6.9 偏暗；浅色侧则把 Solarized 的米黄底
（原本 12.9）与 Everforest 的米绿底（原本 13.9）往 7–13 区间里收。
其余预设都是原生值。

配色总览图：[preview-palettes.png](preview-palettes.png)（Pillow 画的模拟界面，深色 7 套 + 浅色 8 套）。

## 生效与持久化

- **生效**：调用主题服务的公开扩展点 `ctx.theme.overrideTokens(source, { token: { light, dark } })`。
  `ui-layout` 会把快照里的 token 直接 `setProperty` 到 `body` 上，所以选色是即时的——设置页本身就会跟着变色。
- **持久化**：`localStorage`（key `dsh-theme-colors/v1`，结构是 `{ enabled, dark, light }`）。
  DSH Desktop 固定监听 `127.0.0.1:19387`，origin 稳定，因此跨重启有效；
  老版本只存了 `dark` 的记录照样能读，浅色侧自动补官方默认值。
- **只注册一层覆盖**：两侧写在同一个 token 对上，某一行两边都等于官方原值时根本不进覆盖层；
  全部复原后覆盖层被释放，配置回到官方原样。
- 顶部的「启用自定义配色」可以整体开关，「全部恢复默认」清空两侧的所有改动。
  总开关关掉时预设卡片仍然可点，点一下会自动重新打开。

## 结构

```
index.js          Host 半：只为在 profile 组合里占一行（Client 模块是从 Host Loader 条目扫描出来的）
client.js         Client 半：设置页 + 深浅两套预设 + 取色器 + token 覆盖（window.__ModuleLoader__.load 手写 bundle）
cordis.patch.yml  bundle 的 patch 层：插入 theme-colors 行
locale/*.json     插件列表里显示的标题/描述
smoke.mjs         自检（含两侧预设的对比度断言与样式护栏）
preview-palettes.png  15 套预设的对比预览图（脚本另存，不参与运行）
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

用极简 React 在 Node 里跑一遍注册契约、文案对齐、状态清洗、深浅两侧的 token 覆盖写入、
模式跟随、预设套用与设置页渲染，共 82 项断言（含 15 套预设的 11-token 完整性与对比度区间、
样式护栏），全 PASS 才算接线正确。它不启动浏览器，也不连 DSH。
