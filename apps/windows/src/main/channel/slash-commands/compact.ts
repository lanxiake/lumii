import type { CommandHandler, CommandContext } from '../types'

/**
 * 通道侧 /compact：优先走 LLM 摘要压缩，无实例时降级为同步裁剪。
 */
export const compactCommand: CommandHandler = {
  description: '压缩当前会话上下文（LLM 摘要 + 保留最近消息）',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge } = ctx
    const { sessionKey, instanceId } = session

    const result = instanceId
      ? await bridge.compactContextAsync(instanceId, sessionKey)
      : { ...bridge.compactContext(sessionKey), hadSummary: false }

    if (result.messagesRemoved === 0) {
      await adapter.sendTextReply(
        session,
        result.previousMessageCount === 0
          ? 'ℹ️ 当前没有消息可压缩。'
          : `⚠️ 压缩未完成（当前 ${result.previousMessageCount} 条）。`,
      )
      return
    }

    const summaryNote = result.hadSummary ? '，已生成摘要' : ''
    await adapter.sendTextReply(
      session,
      `✅ 上下文压缩完成：删除 ${result.messagesRemoved} 条，保留 ${result.newMessageCount} 条${summaryNote}。`,
    )
  },
}
