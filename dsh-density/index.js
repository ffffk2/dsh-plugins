/**
 * 界面密度与配色 —— Host 半。
 *
 * 功能全在 Client 半（设置页 + 主题 token 覆盖 + 侧栏/工作区样式），偏好存在浏览器 localStorage 里。
 * Host 半只负责让本包在 profile 组合里占一行：`@deepseek-ai/dsh-client-modules`
 * 是扫描 Host Loader 的条目来发现 `dsh.client` 声明的，没有这一行 Client 半不会被加载。
 */
export const name = 'density'

/**
 * 注册本插件的 Host 行。
 * @param ctx - 拥有这一行的插件上下文。
 */
export function apply(ctx) {
  try {
    ctx.logger?.info?.('[density] 已启用：设置 → 排版密度 / 工作区配色')
  } catch {
    /* 日志失败不影响插件 */
  }
}
