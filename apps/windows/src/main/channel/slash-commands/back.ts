/**
 * /back — 回到本渠道自己的会话
 *
 * 跨渠道接续会把该渠道后续消息路由到别的会话（客户端 / 另一个渠道），
 * 之前没有任何命令能退回来（非微信渠道连 /unlink 都没有）。
 * 本命令把路由改回「该渠道本人最近用的会话」，不动用户显式 /link 的绑定。
 */

import type { CommandHandler, CommandContext } from '../types'

export const backCommand: CommandHandler = {
  description: '回到本渠道自己的会话（取消跨渠道接续）',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge } = ctx

    if (!adapter.resetToChannelSession) {
      await adapter.sendTextReply(session, '❌ 当前通道不支持该操作。')
      return
    }

    const target = adapter.resetToChannelSession(session.channelUserId)
    if (target === session.sessionKey) {
      await adapter.sendTextReply(session, '当前已经在你自己渠道的会话里了，直接发消息即可。')
      return
    }

    bridge.notifyNavigateToSession(target)
    await adapter.sendTextReply(
      { ...session, sessionKey: target, instanceId: null },
      '✅ 已回到本渠道的会话，后续消息在这里继续。',
    )
  },
}
