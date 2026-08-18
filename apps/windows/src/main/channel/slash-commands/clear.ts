import type { CommandHandler, CommandContext } from '../types'

export const clearCommand: CommandHandler = {
  description: '清空当前会话消息，保留 sessionKey',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge, sessionManager } = ctx
    const { sessionKey } = session

    // 销毁现有实例
    if (session.instanceId) {
      try { bridge.destroy(session.instanceId) } catch { /* ignore */ }
    }

    // 清空 DB 消息
    bridge.clearConversationMessages(sessionKey)

    // 清除 sessionManager 的 prompt 锁（允许新的 prompt 立即执行）
    sessionManager?.clearLock(sessionKey)

    // 通知渲染进程
    bridge.notifyIncomingMessage(sessionKey, '/clear')

    // 通知通道用户
    await adapter.sendTextReply(session, '✅ 当前会话已清空，可继续发消息开启新对话。')
  },
}
