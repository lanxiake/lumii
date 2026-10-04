/**
 * 由首条用户消息文本推导会话标题（会话尚未被命名时的兜底）。
 * 供渲染层与主进程 IPC（本地 Agent Runtime 落库）共用。
 */

/**
 * 根据用户首条消息纯文本生成侧边栏 / 数据库标题。
 *
 * 先按句末标点（`。！？!?`）切出**首个句子**，再清掉行首列表符号与文件名敏感字符。
 * 顺序不能反：先清字符会把 `？！` 也抹掉，句子再也切不开，整段消息会被塞进标题
 * ——「先做这个！然后再说」会变成「先做这个然后再说」。
 *
 * **不做长度截断、不拼接省略号**：曾经砍到 18 字再补「...」，等于把省略号写进了数据，
 * 侧栏与重命名框里显示的都不是真名，改名时也没法还原。显示层的截断交给 CSS
 * （`text-overflow`），数据层只负责给出真实文本。
 */
export function deriveConversationTitleFromUserText(raw: string): string {
  const flat = compactSpaces(raw.replace(/\r?\n/g, ' '))
  if (!flat) {
    return '新对话'
  }
  const firstSentence = flat.split(/[。！？!?]/).map((s) => s.trim()).find(Boolean) || flat
  const cleaned = compactSpaces(
    firstSentence
      .replace(/^[#>\-\d\.\)\s]+/, '')
      .replace(/[<>:"/\\|?*：""''、？！＊＜＞＼／｜]/g, ''),
  )
  return cleaned || '新对话'
}

function compactSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
