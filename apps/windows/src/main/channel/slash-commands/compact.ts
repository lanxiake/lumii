import type { CommandHandler, CommandContext } from '../types'

export const compactCommand: CommandHandler = {
  description: '压缩当前会话上下文（保留最近消息，删除旧消息）',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge } = ctx
    const { sessionKey } = session

    const result = bridge.compactContext(sessionKey)
    if (result.messagesRemoved === 0) {
      await adapter.sendTextReply(session, `ℹ️ 消息数量不足，无需压缩（当前 ${result.previousMessageCount} 条）。`)
    } else {
      await adapter.sendTextReply(
        session,
        `✅ 上下文压缩完成：删除 ${result.messagesRemoved} 条，保留 ${result.newMessageCount} 条。`,
      )
    }
  },
}
