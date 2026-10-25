/**
 * 将渠道 `incoming-*` 占位 id 解析为 DB 中同文案的用户消息 id。
 *
 * 适配器旧路径会先推占位气泡再另造落库 id；已打开会话若不切走重载，
 * 点「重新生成」仍会带着占位 id 打主进程并被存在性校验拒绝。
 * 重发前用正文对齐一次，兼容尚未刷新的内存态。
 */

export interface ResendLookupMessage {
  readonly id: string
  readonly role: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/**
 * @param placeholderId - 渲染层当前持有的消息 id
 * @param placeholderText - 该气泡正文（改前原文；编辑重发时用改前文本去库里对齐）
 * @param dbMessages - 会话近期消息（时间升序）
 * @returns 可交给主进程的真实 id；占位且找不到时返回 null；非占位原样返回
 */
export function resolveIncomingPlaceholderId(
  placeholderId: string,
  placeholderText: string,
  dbMessages: readonly ResendLookupMessage[],
): string | null {
  if (!placeholderId.startsWith('incoming-')) return placeholderId
  for (let i = dbMessages.length - 1; i >= 0; i--) {
    const m = dbMessages[i]!
    if (m.role !== 'user') continue
    const text = m.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('')
    if (text === placeholderText) return m.id
  }
  return null
}
