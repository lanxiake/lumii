/**
 * 渠道入站用户消息：落库与推 UI 共用同一 messageId。
 *
 * 历史坑：适配器先 `notifyIncomingMessage`（渲染层拿到 `incoming-*` 占位 id），
 * 再 `saveMessage`（库里另生成 UUID）。客户端点「重新生成」会用占位 id 查库，
 * 触发「目标消息不存在（可能已被删除），已取消重发」。
 * 微信盯梢路径已按「先 save 再带 row.id 推送」做对；本助手把同一契约抽成共用入口。
 */

export interface IncomingUserMessageRepo {
  saveMessage(params: {
    readonly conversationId: string
    readonly role: 'user'
    readonly contentJson: { readonly type: 'text'; readonly text: string }
  }): { readonly id: string }
}

/**
 * 先落库用户消息，再用落库 id 推给渲染层，返回该 id。
 *
 * @param repo - ConversationRepo（或测试替身）
 * @param notify - bridge.notifyIncomingMessage
 * @param sessionKey - 会话键（同时作为 conversationId）
 * @param text - 用户消息正文
 */
export function persistAndNotifyIncomingUserMessage(
  repo: IncomingUserMessageRepo,
  notify: (sessionKey: string, text: string, messageId: string) => void,
  sessionKey: string,
  text: string,
): string {
  const row = repo.saveMessage({
    conversationId: sessionKey,
    role: 'user',
    contentJson: { type: 'text', text },
  })
  notify(sessionKey, text, row.id)
  return row.id
}
