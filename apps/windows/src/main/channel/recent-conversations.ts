/**
 * 「最近会话」列表的扫描窗口与排序（10-S5 · D3）
 *
 * 底层 `conversationRepo.listActiveConversations` 的排序是 `is_pinned DESC, last_msg_at DESC`
 * ——**置顶的旧会话会排在真正最近的会话前面**，直接照搬会让「取最近一条」取到两天前的闲聊。
 *
 * 四处消费方（路由兜底查 own、接续候选、`/resume`、`session_list`）此前各写一套魔数
 * （200 / 50 / 100 / 200）并各自重排。这里收成一份：**取宽窗口 + 自己按时间倒序**，
 * 需要更窄的窗口（如接续的 3 天活跃窗）由调用方自己过滤。
 */

/**
 * 扫描窗口条数。
 *
 * 取 200 的依据：这是「置顶优先」序下的安全余量——置顶会话多时，真正最近的会话可能排在很后，
 * 而各消费方都还要按自己的规则过滤（渠道归属、时间窗、关键词）。查询本身是单表索引扫描，不贵。
 */
export const RECENT_SCAN_LIMIT = 200

/**
 * 按 `updatedAt` 倒序。
 *
 * 时间戳坏掉的行直接丢弃：排不了序，也说不清新旧——放进候选只会让用户看到莫名其妙的目标。
 */
export function sortByUpdatedAtDesc<T extends { updatedAt: string }>(rows: readonly T[]): T[] {
  return rows
    .map((row) => ({ row, ts: Date.parse(row.updatedAt) }))
    .filter((entry) => Number.isFinite(entry.ts))
    .sort((a, b) => b.ts - a.ts)
    .map((entry) => entry.row)
}
