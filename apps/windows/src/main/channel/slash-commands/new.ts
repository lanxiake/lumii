import type { CommandHandler, CommandContext } from '../types'

export const newCommand: CommandHandler = {
  description: '新建独立会话（新 sessionKey 含时间戳）',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge, sessionManager } = ctx
    const { channelUserId } = session

    const newSessionKey = `weixin:${channelUserId}:${Date.now()}`
    const newTitle = `微信对话 - ${new Date().toLocaleString('zh-CN')}`

    bridge.ensureConversationExists(newSessionKey, newTitle)

    // 清除旧会话的 prompt 锁（避免旧会话的 prompt 阻塞新会话）
    sessionManager?.clearLock(session.sessionKey)
    // 清除新会话的 prompt 锁（确保新会话干净启动）
    sessionManager?.clearLock(newSessionKey)

    // 持久化新 sessionKey，使后续消息路由到新会话
    adapter.setActiveSessionKey?.(channelUserId, newSessionKey)

    // 通知渲染进程导航到新会话
    const newSession = { ...session, sessionKey: newSessionKey, instanceId: null }
    bridge.notifyNavigateToSession(newSessionKey, newTitle)
    bridge.notifyIncomingMessage(newSessionKey, '/new')

    await adapter.sendTextReply(
      newSession,
      `✅ 已新建对话，后续消息将在新会话中进行。\n会话ID: ${newSessionKey.slice(-8)}`,
    )
  },
}
