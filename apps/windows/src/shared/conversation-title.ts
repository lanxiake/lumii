/**
 * 由首条用户消息文本推导会话标题（与 useChat autoTitle 规则一致）。
 * 供渲染层与主进程 IPC（本地 Agent Runtime 落库）共用。
 */

/**
 * 根据用户首条消息纯文本生成侧边栏 / 数据库标题。
 */
export function deriveConversationTitleFromUserText(raw: string): string {
  const content = normalizeTitleSource(raw)
  if (!content) {
    return '新对话'
  }
  const firstSentence = content.split(/[。！？!?]/).map((s) => s.trim()).find(Boolean) || content
  const compact = compactSpaces(firstSentence)
  if (compact.length <= 18) {
    return compact
  }
  return `${compact.slice(0, 18)}...`
}

function normalizeTitleSource(raw: string): string {
  return compactSpaces(
    raw
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[#>\-\d\.\)\s]+/, '')
      .replace(/[<>:"/\\|?*：""''、？！＊＜＞＼／｜]/g, '')
      .trim(),
  )
}

function compactSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
