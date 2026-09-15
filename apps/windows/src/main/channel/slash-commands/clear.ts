import type { CommandHandler, CommandContext } from '../types'
import { getChannelFeatures } from '../channel-feature-store'
import { resolveContinuityForChannel } from '../cross-channel-continuity'

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

    // 清空即重新开始：作废接续提示并允许再提示一次（10-S4）。
    // 其它会换会话的命令（/new、/resume、/back）不必走这一步——路由一变就自动重新武装。
    if (getChannelFeatures().crossChannelContinuityEnabled) {
      resolveContinuityForChannel({ enabled: true, bridge })?.resetNotice(
        session.channelType,
        session.channelUserId,
      )
    }

    // 通知通道用户
    await adapter.sendTextReply(session, '✅ 当前会话已清空，可继续发消息开启新对话。')
  },
}
