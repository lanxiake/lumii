/**
 * /link 和 /unlink — 会话绑定
 *
 * /link <conversationId>  把该渠道用户绑定到指定会话，实现跨渠道上下文共享
 * /unlink                 解除绑定，回到本渠道自己的会话
 *
 * 微信有持久化绑定层（WeixinSessionBindingManager）；其它渠道没有绑定概念，
 * /link 退化为「切到该会话」——同样经 ChannelSessionStore 持久化，重启不丢。
 */

import type { CommandHandler, CommandContext } from '../types'

export const linkCommand: CommandHandler = {
  description: '绑定到指定会话（跨渠道共享上下文）',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge, bindingManager, args } = ctx
    const conversationId = args.trim()

    if (!conversationId) {
      await adapter.sendTextReply(
        session,
        '用法：/link <conversationId>\n请提供要绑定的会话 ID（可用 /resume 查看列表）。',
      )
      return
    }

    // 验证会话是否存在
    const conv = bridge.conversationRepo.getConversation(conversationId)
    if (!conv) {
      await adapter.sendTextReply(
        session,
        `❌ 会话不存在：${conversationId}\n请检查 conversationId 是否正确，可用 /resume 查看。`,
      )
      return
    }

    // 微信写持久化绑定层；其它渠道只写路由（ChannelSessionStore 同样持久化）
    bindingManager?.bind(session.channelUserId, conversationId)

    // 立即更新活跃会话（让下一条消息直接路由到绑定会话）
    adapter.setActiveSessionKey?.(session.channelUserId, conversationId)

    await adapter.sendTextReply(
      session,
      `✅ 已绑定到会话 ${conversationId}\n后续消息将共享该会话的上下文。\n发送 /back 或 /unlink 可回到本渠道会话。`,
    )
  },
}

export const unlinkCommand: CommandHandler = {
  description: '解除会话绑定，回到本渠道自己的会话',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge, bindingManager } = ctx

    const bound = bindingManager?.getBoundConversationId(session.channelUserId) ?? null
    if (!bound) {
      await adapter.sendTextReply(session, '当前未绑定任何会话。发送 /back 可回到本渠道会话。')
      return
    }

    // 显式解绑：用户就是要断开这条绑定，不走 resetToChannelSession 里那层「保护绑定」的判断
    bindingManager?.unbind(session.channelUserId)

    const target = adapter.resetToChannelSession?.(session.channelUserId)
    if (target && target !== session.sessionKey) {
      bridge.notifyNavigateToSession(target)
      await adapter.sendTextReply(
        { ...session, sessionKey: target, instanceId: null },
        '✅ 已解除绑定，后续消息回到本渠道会话。',
      )
      return
    }
    await adapter.sendTextReply(session, '✅ 已解除绑定，后续消息使用独立会话。')
  },
}
