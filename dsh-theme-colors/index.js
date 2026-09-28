/**
 * 外观颜色 —— Host 半。
 *
 * 这个插件的功能全在 Client 半（设置页 + 取色器 + 主题 token 覆盖）：
 * 配色存在浏览器 localStorage 里，主题服务 `ctx.theme` 也只存在于浏览器，
 * 所以 Host 半只负责一件事：让本包在 profile 组合里占一行。
 * `@deepseek-ai/dsh-client-modules` 是扫描 Host Loader 的条目来发现
 * `dsh.client` 声明的，没有这一行，Client 半就不会被 Web 端加载。
 */
export const name = 'theme-colors'

/**
 * 注册本插件的 Host 行。
 * @param ctx - 拥有这一行的插件上下文。
 */
export function apply(ctx) {
  try {
    ctx.logger?.info?.('[theme-colors] 已启用：设置 → 外观颜色 可自定义深色模式配色')
  } catch {
    /* 日志失败不影响插件 */
  }
}
