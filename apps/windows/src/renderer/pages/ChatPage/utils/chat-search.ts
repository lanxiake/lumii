/**
 * 对话内搜索的纯逻辑：在当前会话的消息里找命中，并给出「第几条 / 共几条」。
 *
 * 与侧栏搜索的区别：**不查库**。对话内搜索只搜当前会话、搜的是屏幕上这份
 * 消息列表（含刚流出还没落库的那几条），所以纯内存、逐字响应即可。
 */

export interface ChatSearchTarget {
  readonly id: string
  /** 仅用于展示与计数；不参与匹配 */
  readonly role?: string
  /** 这条消息里所有可搜文本拼起来的结果 */
  readonly text: string
}

export interface ChatSearchHit {
  readonly messageId: string
  /** 这条消息里命中的次数 */
  readonly count: number
}

/**
 * 找出所有命中的消息，按消息在会话中的顺序返回。
 *
 * 大小写不敏感（与侧栏 SQL LIKE 的语义一致）；空关键词返回空数组——
 * 调用方据此显示「无结果」而不是「0 条里的第 1 条」。
 */
export function findChatSearchHits(
  messages: readonly ChatSearchTarget[],
  keyword: string,
): ChatSearchHit[] {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return []
  const hits: ChatSearchHit[] = []
  for (const message of messages) {
    const lower = message.text.toLowerCase()
    let count = 0
    let at = lower.indexOf(needle)
    while (at >= 0) {
      count += 1
      at = lower.indexOf(needle, at + needle.length)
    }
    if (count > 0) hits.push({ messageId: message.id, count })
  }
  return hits
}

/** 在命中列表里前进/后退一格（循环）；没有命中时返回 -1 */
export function stepHitIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1
  // 从「还没开始」(-1) 出发时，前进落到第一条、后退落到最后一条
  if (current < 0) return direction === 1 ? 0 : total - 1
  return ((current + direction) % total + total) % total
}
