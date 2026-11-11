# dsh-density

给 DSH 的**左侧工作区列表**、**会话正文**和**工作区配色**加外观控制：
**设置 → 排版密度**（正文/侧栏密度）与 **设置 → 工作区配色**（每个工作区一种底色）。
字号不用再为了塞下更多内容而一味调小，侧栏也不会一条会话占掉 32px，
多个工作区还能靠底色一眼区分。

## 为什么需要它

官方 `@deepseek-ai/dsh-client-ui-theme` 的「正文字号」只改字号，不改行高公式：

```css
line-height: calc(24px + (字号 - 14px));
```

于是字号越小，行高比例反而越大：

| 正文字号 | 官方行高 | 行高倍数 |
|---|---|---|
| 14px（默认） | 24px | 1.71× |
| 13px | 23px | 1.77× |
| 10px | 20px | 2.00× |

长回答、表格和 Markdown 列表因此显得很松，一屏看不到多少内容。
本插件把 Markdown 正文的行高从字号公式里拆出来，单独按倍数设置；
侧栏则注入一段只作用于左侧栏的样式。两者都不修改 asar 里的任何文件。

## 能改什么

- **侧栏密度**：官方 / 紧凑 / 更紧凑；默认紧凑
- **工作区底色**：默认按工作区自动分配不同颜色，也可逐个取色或恢复自动
- **正文行高**：1.25–1.80，默认 1.5×
- **消息间距**：0–8 px，默认 3 px
- **正文预设**：官方 / 紧凑 / 极紧凑；滑杆一动就变成「自定义」
- **字号步进**：正文 10–22 px、代码 10–16 px，写的是官方 `ui-theme` 的同一个设置，
  与「通用 → 正文/代码字号」、`Ctrl`/`Cmd` + `-` 实时同步
- **预览**：用当前字号和行高渲染两段示例，改完马上能判断密度

### 侧栏密度（这次的重点）

| 位置 | 官方 | 紧凑 | 更紧凑 |
|---|---|---|---|
| 会话行高 | 32px | 24px | 22px |
| 工作区行高 | 34px | 26px | 24px |
| 导航行（插件/自动化/更多） | 36px | 28px | 26px |
| 新建会话按钮 | 38px | 30px | 28px |
| 品牌行 | 60px（Windows 标题栏 40px） | 38px | 36px |
| 会话标题字号 | 14px | 12.5px | 12px |
| 根内边距（上下） | 6px | 3px | 2px |
| 侧栏左右内边距 | 8px | 6px | 6px |

以 900px 高的窗口、5 条会话 + 5 个工作区为例，紧凑档大约能多显示 5–6 行；
如果列表更长，省下来的每一行都会变成可见会话。

### 工作区配色

左侧栏的每个工作区分组会自动分到一种淡色底，默认互不相同：目录行深一点，
下面的会话列表浅一点，整组仍然是一套颜色。

- 颜色由 `workspaceId` 哈希到 10 色色板，遇到重复就线性探测下一个；
  10 个工作区以内不会出现同色（用户手动改成同色除外）
- 给某个工作区挑自定义色**不会**改变其他工作区的自动色；自动色只和
  工作区 ID、创建时间与列表有关
- 在 **设置 → 工作区配色** 里，每个工作区都有取色器；改动立即写回左栏
- 点「恢复自动」清掉单个工作区的覆盖值；「全部恢复自动」清掉所有覆盖值
- 开关关掉后不注入任何颜色样式，左栏回到官方外观；再打开会恢复之前的设置

颜色是两层**叠色**，不是把整行刷成饱和色：整组 16%，目录行再叠到 24%，
会话文字仍用官方前景色，悬停和菜单打开时的官方背景仍叠在下面。
效果如下（浅色主题）：

| 工作区 | 自动色 |
|---|---|
| neri-player-zjf | 青绿 |
| deepseekHarnessPlugins | 橙 |
| work | 紫 |
| oppein-crm | 绿 |
| crm19 | 黄 |
| cc | 品红 |

作用范围：

| 会改变 | 不会动 |
|---|---|
| 左栏的会话/工作区/导航/品牌/底部账号行 | 主对话区、右侧栏、设置弹窗 |
| 侧栏字号、行高、内边距、分组间距 | 用户气泡的固定行高 |
| 整个工作区分组的底色（目录深、会话浅） | 主区、右侧栏、会话行自身的 hover/选中背景 |
| Markdown 正文、表格、`h4`、消息间距 | 工具行、按钮与图标尺寸 |
| | 字体家族、圆角、阴影 |

## 原理

### 正文：覆盖 token

`ui-theme` 把 `overrideTokens` 的每个 token 直接 `setProperty` 到 `body` 上，
并排在官方字号变量之后，所以覆盖层的优先级高于官方 token。插件覆盖这些值：

```text
--dsw-font-markdown-base               正文
--dsw-font-markdown-base-strong        正文加粗
--dsw-font-markdown-base-italic        正文斜体
--dsw-font-markdown-base-strong-italic 正文加粗斜体
--dsw-font-markdown-h4                 四级标题
--dsw-font-markdown-table              表格正文
--dsw-font-markdown-table-head         表头
--dsh-chat-flow-gap                    相邻消息的默认间距
```

值里继续引用官方的 `--dsh-content-font-size` 与
`--dsh-content-font-size-secondary`，所以改字号时行高倍数不用重新计算：

```css
--dsw-font-markdown-base:
  var(--dsh-content-font-size, 14px) / 1.5 var(--dsw-font-family);
```

只覆盖 token、不覆盖 `.module.css` 的哈希类名。好处是升级 DSH 后不会因为
类名变化突然失效；代价是用户气泡、工具行等仍使用官方的固定行高。

### 侧栏：注入作用域样式

侧栏的行高、字号是写死的 px，没有 token；官方只暴露了 4 个布局变量：

```css
--dsh-sidebar-inline-padding
--dsh-sidebar-row-padding
--dsh-sidebar-label-gap
--dsh-sidebar-paint-inset
```

所以插件向 `document.head` 注入一段 `<style data-dsh-density="sidebar">`，
先覆盖这 4 个变量，再收紧行高/字号。选择器只使用稳定属性：

- `[data-slot="sidebar"]` —— 左栏根
- `[data-row-key^="session:"]` / `^="workspace:"` —— 会话/工作区行
- `[role="tree"]` —— 会话树
- 类名只取 `_newSession` / `_panelRow` / `_sectionHeader` 这类**局部名**，
  不依赖 `wnFoaW` 这种构建哈希

所有规则都以 `[data-slot="sidebar"]` 开头，主区、右侧栏、设置弹窗完全不受影响。
关闭侧栏密度时会移除这个 `<style>`，恢复官方尺寸；插件卸载时也会移除。

### 工作区底色：整组浅色 + 目录深色

工作区分组的类名和背景色同样没有官方 token。插件为每个工作区生成两条规则：

```css
/* 整组 16% 浅色：会话列表直接透出这层 */
[data-slot="sidebar"] div[class*="_groupSection"]:has(
  > [data-row-key="workspace:<id>"],
  > * > [data-row-key="workspace:<id>"]
) {
  background-color: rgba(18, 165, 148, 0.16);
  border-radius: 8px;
}

/* 目录行再叠一层 24%，形成“目录深、会话浅” */
[data-slot="sidebar"] [data-row-key="workspace:<id>"] {
  position: relative;
  isolation: isolate;
}
[data-slot="sidebar"] [data-row-key="workspace:<id>"]::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: #12a594;
  opacity: 0.24;
  pointer-events: none;
  z-index: -1;
}
```

组背景不占用 `::before/::after`：官方拖动工作区时用这两个伪元素画插入线，
配色不能抢。目录行仍用负 `z-index` 的伪元素，官方 hover / 菜单打开时的背景
仍然可见。`isolation: isolate` 让行成为层叠上下文，伪元素画在行背景之上、文字之下。

工作区行外面可能套一层 HoverCard 的 `span`，所以组选择器同时匹配
`> [data-row-key]` 和 `> * > [data-row-key]`；只匹配一层，避免父分组误命中
嵌套工作区。所有规则都以 `[data-slot="sidebar"]` 开头，不会碰主区。
关闭开关或插件卸载时会移除整段样式。

自动色的持久化只存“用户改过的”工作区：

```json
{
  "enabled": true,
  "colors": {
    "<workspaceId>": "#123456"
  }
}
```

没改过的工作区不写盘，由 ID 和当前列表实时推导；这样重装、换机器后默认配色
仍然能自动出现。

## 安装

`desktop` profile 被 Electron 独占，手工接入有两条路，**二选一**：

### A. 热加载（本机当前用法，不用重启）

1. `$DSH_HOME/profiles/desktop/package.json` 的 `dependencies` 里加
   `"@local/dsh-density": "link:<repo>/dsh-density"`，在 profile 目录跑 `pnpm install`。
2. 在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 末尾加：

   ```yaml
   - insert:
       - id: density
         name: '@local/dsh-density'
   ```

3. `patchReload: live` 会直接加载 Host 行；**刷新一次页面**即可看到 Client 半。

### B. 正式收进 bundle（需要重启）

1. 同样先加 `dependencies` 并 `pnpm install`。
2. 把 `@local/dsh-density` 追加到 `dsh.profile.bundles`，由本包的
   `cordis.patch.yml` 自动插入 Host 行。
3. **删掉 A 里的 `- insert:` 块**，否则同一个包会插入两次、出现重复 id。
4. 重启 DSH Desktop。

装好后打开 **设置 → 排版密度**，默认已经是「紧凑」；点「官方」即可回到原始排版。
工作区底色在 **设置 → 工作区配色**，默认开启并自动分配。

偏好保存在浏览器的 `localStorage`：

- 排版：`dsh-density/v1`
- 工作区配色：`dsh-density/workspace-colors/v1`

字号不在这里存，仍由官方 `ui-theme` 设置持久化。

## 验证

```powershell
node dsh-density\smoke.mjs
```

通过时打印 `ALL PASS`。脚本覆盖 Host/Client 注册契约、默认 token 覆盖、侧栏样式
注入/切换/移除、正文预设与滑杆、字号步进、工作区自动配色/取色/恢复自动/开关/
列表增删、脏 localStorage 清洗、卸载清理，以及样式护栏（正文与设置 UI 无硬编码
颜色、`var()` 只引用宿主 token 家族、组件类名全部带 `dshtd-` 前缀、侧栏规则全部
限定在 `[data-slot="sidebar"]` 内、工作区配色只命中 `workspace:` 行）。

## 已知限制

- **用户气泡行高不变**：官方气泡用 `calc(22px + delta)` 的固定行高，硬压会连带
  影响同一条 CSS 里的图标和操作区。插件选择只改 Markdown 正文。
- **部分分组间距不变**：`[data-chat-group-part=response]` 等分组会把间距写成
  12/16px，官方样式直接写在流项上，`--dsh-chat-flow-gap` 只能影响没有显式覆盖的行。
- **侧栏是 CSS 覆盖，不是官方 token**：官方没有把行高/字号暴露成 token，
  插件只能用 `[data-slot="sidebar"]` + 局部类名覆盖。DSH 若改动侧栏结构，
  最坏情况是某几条规则失效、侧栏回到官方尺寸，不会影响主区；升级后建议看一眼。
- **侧栏折叠态保持官方**：折叠成 36px 的窄条时，根内边距规则不生效，避免把折叠按钮挤歪。
- **工作区底色是叠色**：整组 16%、目录行 24%，是为浅色/深色都能读文字选的；
  如果选到接近背景的浅色（例如白、浅灰），色感会变弱。取色器本身不限制颜色，
  按需选深一点即可。
- **组背景依赖 `:has()` 与当前一层 HoverCard 包裹**：官方若改结构，组背景可能
  失效，但目录行颜色仍在；嵌套工作区会与父组轻微混色。
- **超过 10 个工作区会循环色板**：自动色只保证 10 个以内互不相同；更多时
  允许重复，仍可用取色器区分。
- **localStorage 跟随 origin**：Desktop 的本地 origin 固定，正常重启不丢；
  如果改用别的端口启动 Web GUI，会是一份新的偏好。
