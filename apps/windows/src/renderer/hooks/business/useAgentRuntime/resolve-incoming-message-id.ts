/**
 * 将渠道入站占位 id（incoming-*）解析为 DB 中真实消息 id。
 *
 * 修复前：notifyIncomingMessage 未带落库 id 时，渲染层长期持有 incoming-*，
 * 点「重新生成」会因 messageExists 失败而取消。会话切换可冷加载消歧；
 * 本函数给「仍停在当前会话、未切换」的路径做防御性 remap。
 */

export interface ResendAnchorMessage {
  readonly id: string
  readonly role: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/**
 * 从消息 content 拼出纯文本（与 regenerate 锚点提取一致）。
 */
export function textOfMessageContent(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  return content.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('')
}

/**
 * 若 messageId 是 incoming-* 占位，则在 DB 页中按「同角色 + 同正文」找最近一条真实 id。
 * 找不到则返回原 id（由主进程继续按不存在拒绝）。
 *
 * @param messageId - 渲染层当前持有的消息 id
 * @param anchorText - 重发锚点正文（改前内容；编辑重发时用改前文本匹配库）
 * @param dbMessages - conversation:messages 返回的一页（时间升序）
 */
export function resolveIncomingMessageId(
  messageId: string,
  anchorText: string,
  dbMessages: readonly ResendAnchorMessage[],
): string {
  if (!messageId.startsWith('incoming-')) return messageId
  const needle = anchorText
  // 同文可能多条：取时间序最后一条（最近一次入站），与 regenerate 锚点语义一致
  let resolved: string | undefined
  for (const m of dbMessages) {
    if (m.role !== 'user') continue
    if (textOfMessageContent(m.content) !== needle) continue
    resolved = m.id
  }
  return resolved ?? messageId
}
