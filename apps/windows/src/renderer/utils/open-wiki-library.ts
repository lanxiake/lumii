/**
 * 跨层打开 Wiki 资料库（Settings Hub → 资料库 Tab）
 */

/** Hub 已打开资料库时再次触发（如切到收件箱）的事件名 */
export const OPEN_WIKI_LIBRARY_EVENT = 'mtbot:open-wiki-library'

/** sessionStorage：Wiki 工作区默认导航（如 inbox） */
export const WIKI_INIT_NAV_KEY = 'mtbot_wiki_init_nav'

/** Wiki 工作区可通过 sessionStorage 指定的初始导航 */
export type WikiInitNav = 'inbox'

/**
 * 读取并清除 sessionStorage 中的 Wiki 初始导航标记
 */
export function consumeWikiInitNav(): WikiInitNav | null {
  try {
    const nav = sessionStorage.getItem(WIKI_INIT_NAV_KEY) as WikiInitNav | null
    if (nav) sessionStorage.removeItem(WIKI_INIT_NAV_KEY)
    return nav
  } catch {
    return null
  }
}

/**
 * 打开设置 Hub 的资料库 Tab，并默认进入收件箱视图
 */
export function openWikiLibrary(): void {
  try {
    sessionStorage.setItem(WIKI_INIT_NAV_KEY, 'inbox')
  } catch {
    /* ignore */
  }
  window.dispatchEvent(
    new CustomEvent('mtbot:navigate-request', { detail: { view: 'wiki' } }),
  )
  window.dispatchEvent(new CustomEvent(OPEN_WIKI_LIBRARY_EVENT))
}
