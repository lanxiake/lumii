/**
 * 主窗口导航白名单。
 *
 * 主窗口只有一种合法文档：渲染层自己（dev = `ELECTRON_RENDERER_URL` 的 origin，
 * 生产 = `file://…/renderer/index.html`）。主 frame 上出现外部 http(s) URL，
 * 就意味着「界面被换掉了」。
 *
 * ⚠️ **为什么 `will-navigate` 不够**：那条只覆盖页面自己发起的导航（点 `<a href>`、
 * 改 `location`）。CDP 的 `Page.navigate` 由浏览器进程直接下发，不经过它 ——
 * 实测 2026-11-11：小红书发布脚本连上 dev 客户端的 9222，把主窗口整页导航到
 * `creator.xiaohongshu.com`，无边框窗口里连关闭按钮都没了。`did-start-navigation`
 * 在导航真正开始后触发，是最后一道能看见它的事件。
 */
export function shouldBlockMainFrameNavigation(url: string, rendererUrl?: string): boolean {
  // 只管 http(s)：`about:blank`（初始页）、`file:`、`lumii-*` 协议一律放行，
  // 与 `will-navigate` 守卫同口径。
  if (!/^https?:\/\//i.test(url)) return false
  // 生产模式没有 dev server，任何 http(s) 都不是渲染层。
  if (!rendererUrl) return true
  try {
    return new URL(url).origin !== new URL(rendererUrl).origin
  } catch {
    return true
  }
}
