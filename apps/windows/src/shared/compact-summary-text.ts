/**
 * 压缩摘要在对话流中的识别与正文提取。
 * 手动压缩落库为 `[对话摘要]\n…`；自动压缩注入 `<conversation_summary>` 用户消息。
 */

export const COMPACT_SUMMARY_PREFIX = '[对话摘要]'

/**
 * 判断一段文本是否为压缩摘要（应在对话流中折叠进压缩卡片，而不是当普通气泡）。
 */
export function isCompactSummaryText(text: string | undefined | null): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  return (
    text.startsWith(COMPACT_SUMMARY_PREFIX) ||
    text.includes('<conversation_summary>') ||
    text.includes('This session is being continued from a previous conversation')
  )
}

/**
 * 抽出可供用户阅读的摘要正文（去掉前缀与 XML 包装）。
 */
export function unwrapCompactSummaryText(text: string): string {
  const tagged = text.match(/<conversation_summary>([\s\S]*?)<\/conversation_summary>/)
  if (tagged?.[1]) return tagged[1].trim()

  const continued = text.match(
    /The summary below covers the earlier portion of the conversation\.\s*([\s\S]*?)(?:\n\n(?:Continue the conversation|IMPORTANT:|$))/i,
  )
  if (continued?.[1]) return continued[1].trim()

  if (text.startsWith(COMPACT_SUMMARY_PREFIX)) {
    return text.slice(COMPACT_SUMMARY_PREFIX.length).replace(/^\s*\n?/, '').trim()
  }
  return text.trim()
}
