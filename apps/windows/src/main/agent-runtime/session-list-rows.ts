/**
 * session_list 工具的输出组装（纯函数，便于测试）
 *
 * Agent 要能「帮用户查会话」，前提是拿到的列表可信：按时间倒序、标明来源渠道、
 * 指出当前会话。底层 `conversationRepo.listActiveConversations` 的排序是
 * `is_pinned DESC, last_msg_at DESC`——置顶的旧会话会排在真正最近的会话前面，
 * 直接照搬会让模型挑错会话，所以这里自己重排。
 */

import { resolveChannelIdentity } from '../channel/channel-identity'
import { RECENT_SCAN_LIMIT, sortByUpdatedAtDesc } from '../channel/recent-conversations'

/** 默认返回条数 / 上限（一次给太多会撑长工具结果、白耗 token） */
export const DEFAULT_SESSION_LIST_LIMIT = 20
export const MAX_SESSION_LIST_LIMIT = 50

/** 扫描窗口：与其它「最近会话」消费方共用一份口径（见 channel/recent-conversations.ts） */
export const SESSION_SCAN_LIMIT = RECENT_SCAN_LIMIT

/** 工具返回给模型的单条会话 */
export interface SessionListRow {
  id: string
  title: string
  /** 来源渠道中文名：客户端 / 微信 / 飞书 / 企业微信 / QQ / 系统 */
  channel: string
  updatedAt: string
  isCurrent: boolean
}

/** 数据源行的最小形状（ConversationRow 的子集，便于测试构造） */
export interface SessionSourceRow {
  id: string
  title: string | null
  last_msg_at: string | null
  created_at: string
  /** 归属落库值（conversations.channel_type）；缺省按前缀回退 */
  channel_type?: string | null
}

/** 组装 session_list 的输出：按时间倒序、可选关键词过滤、截断到 limit */
export function buildSessionListRows(
  rows: readonly SessionSourceRow[],
  opts: { keyword?: string; limit?: number; currentSessionKey?: string | null } = {},
): SessionListRow[] {
  const keyword = opts.keyword?.trim().toLowerCase() ?? ''
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_SESSION_LIST_LIMIT, 1), MAX_SESSION_LIST_LIMIT)
  const current = opts.currentSessionKey ?? null

  return sortByUpdatedAtDesc(
    rows.map((row) => ({
      id: row.id,
      title: row.title ?? '新对话',
      channel: resolveChannelIdentity(row.id, row.channel_type).label || '系统',
      updatedAt: row.last_msg_at ?? row.created_at,
      isCurrent: row.id === current,
    })),
  )
    .filter((s) => !keyword || s.title.toLowerCase().includes(keyword))
    .slice(0, limit)
}
