/**
 * 跨层打开 Wiki 资料库（Settings Hub → 记忆 → Wiki Tab）
 */

/** 记忆页 Tab 切换事件名（Hub 已打开时即时切换） */
export const OPEN_MEMORIES_TAB_EVENT = 'mtbot:open-memories-tab'

/** sessionStorage：Hub 打开后默认记忆 Tab（解决 Hub 未挂载时事件丢失） */
export const MEMORIES_INIT_TAB_KEY = 'mtbot_memories_init_tab'

/** sessionStorage：Wiki 工作区默认导航（如 inbox） */
export const WIKI_INIT_NAV_KEY = 'mtbot_wiki_init_nav'

/** 记忆页可选 Tab */
export type MemoriesTab = 'soul' | 'ai' | 'user-memory' | 'plugin' | 'wiki'

/** Wiki 工作区可通过 sessionStorage 指定的初始导航 */
export type WikiInitNav = 'inbox'

/**
 * 读取 sessionStorage 中的记忆 Tab 标记（不删除）
 */
export function peekMemoriesInitTab(): MemoriesTab | null {
  try {
    return sessionStorage.getItem(MEMORIES_INIT_TAB_KEY) as MemoriesTab | null
  } catch {
    return null
  }
}

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
 * 读取并清除 sessionStorage 中的记忆 Tab 初始标记
 */
export function consumeMemoriesInitTab(): MemoriesTab | null {
  try {
    const tab = sessionStorage.getItem(MEMORIES_INIT_TAB_KEY) as MemoriesTab | null
    if (tab) sessionStorage.removeItem(MEMORIES_INIT_TAB_KEY)
    return tab
  } catch {
    return null
  }
}

/**
 * 打开设置 Hub 的记忆页并切换到 Wiki Tab、收件箱视图
 */
export function openWikiLibrary(): void {
  try {
    sessionStorage.setItem(MEMORIES_INIT_TAB_KEY, 'wiki')
    sessionStorage.setItem(WIKI_INIT_NAV_KEY, 'inbox')
  } catch {
    /* ignore */
  }
  window.dispatchEvent(
    new CustomEvent('mtbot:navigate-request', { detail: { view: 'memories' } }),
  )
  window.dispatchEvent(
    new CustomEvent(OPEN_MEMORIES_TAB_EVENT, { detail: { tab: 'wiki' satisfies MemoriesTab } }),
  )
}
