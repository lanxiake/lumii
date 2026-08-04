/**
 * /link 和 /unlink 命令 — 微信会话绑定
 *
 * /link <conversationId>  将微信用户绑定到指定 Windows 会话，实现跨通道上下文共享
 * /unlink                 解除绑定，恢复独立微信会话
 */

import type { CommandHandler, CommandContext } from '../types'

export const linkCommand: CommandHandler = {
  description: '绑定到指定 Windows 会话（跨通道共享上下文）',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge, bindingManager, args } = ctx
    const conversationId = args.trim()

    if (!conversationId) {
      await adapter.sendTextReply(
        session,
        '用法：/link <conversationId>\n请提供要绑定的会话 ID。',
      )
      return
    }

    if (!bindingManager) {
      await adapter.sendTextReply(session, '❌ 当前通道不支持会话绑定。')
      return
    }

    // 验证会话是否存在
    const conv = bridge.conversationRepo.getConversation(conversationId)
    if (!conv) {
      await adapter.sendTextReply(
        session,
        `❌ 会话不存在：${conversationId}\n请检查 conversationId 是否正确。`,
      )
      return
    }

    bindingManager.bind(session.channelUserId, conversationId)

    // 立即更新活跃会话（让下一条消息直接路由到绑定会话）
    const weixinAdapter = adapter as { setActiveSessionKey?: (userId: string, key: string) => void }
    weixinAdapter.setActiveSessionKey?.(session.channelUserId, conversationId)

    await adapter.sendTextReply(
      session,
      `✅ 已绑定到会话 ${conversationId}\n后续消息将共享该会话的上下文。\n发送 /unlink 可解除绑定。`,
    )
  },
}

export const unlinkCommand: CommandHandler = {
  description: '解除与 Windows 会话的绑定，恢复独立微信会话',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bindingManager } = ctx

    if (!bindingManager) {
      await adapter.sendTextReply(session, '❌ 当前通道不支持会话绑定。')
      return
    }

    const bound = bindingManager.getBoundConversationId(session.channelUserId)
    if (!bound) {
      await adapter.sendTextReply(session, '当前未绑定任何会话。')
      return
    }

    bindingManager.unbind(session.channelUserId)

    // 清除 activeSession 中的绑定会话（恢复默认路由）
    const weixinAdapter = adapter as { clearActiveSession?: (userId: string) => void }
    weixinAdapter.clearActiveSession?.(session.channelUserId)

    await adapter.sendTextReply(
      session,
      '✅ 已解除绑定\n后续消息将使用独立的微信会话。',
    )
  },
}
