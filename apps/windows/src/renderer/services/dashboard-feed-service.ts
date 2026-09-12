/**
 * 概览页资讯流服务 — 封装 window.electronAPI.dashboardFeed
 *
 * 返回类型直接复用主进程 store 的定义（只读类型引用）。
 * 语义与调用点原逻辑一致：page/refresh 失败抛错（由调用方提示）；meta 失败返回 null（不阻塞列表）。
 */
import type {
  DashboardFeedCursor,
  DashboardFeedMeta,
  DashboardFeedPage,
} from '@main/dashboard-feed-store'

/** 当前激活 feed 的元信息（标题/综述/更新时间）；失败返回 null */
export async function fetchFeedMeta(feedId: string): Promise<DashboardFeedMeta | null> {
  const api = window.electronAPI?.dashboardFeed
  if (!api) return null
  const res = await api.meta(feedId)
  return res?.success ? (res.data ?? null) : null
}

/** 拉取一页 feed 条目；接口不可用或失败抛错 */
export async function fetchFeedPage(
  feedId: string,
  opts?: { limit?: number; before?: DashboardFeedCursor | null },
): Promise<DashboardFeedPage> {
  const api = window.electronAPI?.dashboardFeed
  if (!api) throw new Error('资讯接口不可用')
  const res = await api.page(feedId, opts)
  if (!res) throw new Error('资讯接口不可用')
  if (!res.success) throw new Error(res.error ?? '读取资讯失败')
  return res.data ?? { feedId, items: [], nextCursor: null }
}

/** 触发一次抓取（DB 累积合并）；失败抛错 */
export async function refreshDashboardFeed(): Promise<void> {
  const res = await window.electronAPI?.dashboardFeed?.refresh()
  if (!res?.success) throw new Error(res?.error ?? '抓取失败')
}
