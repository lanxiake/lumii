/**
 * QQ 机器人出站 Provider：native_push，peer 为最近入站 openid/group_openid。
 */

import type { QbotLoginService } from '../../qbot-login-service'
import type {
  ChannelPeer,
  ChannelSendMediaParams,
  ChannelSendResult,
  ChannelSnapshot,
  IChannelOutboundProvider,
} from '../outbound-types'

export class QbotChannelProvider implements IChannelOutboundProvider {
  readonly channel = 'qbot' as const
  private readonly recentPeers = new Map<string, ChannelPeer>()

  constructor(private readonly login: QbotLoginService) {}

  rememberInboundPeer(channelUserId: string, chatId: string, chatType: 'p2p' | 'group', label?: string): void {
    const id = channelUserId.trim()
    if (!id) return
    this.recentPeers.set(id, {
      id,
      ...(label ? { label } : {}),
      canSend: true,
      lastInboundAt: Date.now(),
    })
    // 群聊额外记录 group_openid，供 send 路由
    this.recentPeers.set(`group:${chatId}`, {
      id: chatId,
      label: label ? `${label}(群)` : undefined,
      canSend: true,
      lastInboundAt: Date.now(),
    })
  }

  getSnapshot(): ChannelSnapshot {
    const connected = this.login.getStatus() === 'connected'
    return {
      channel: 'qbot',
      connected,
      pushMode: 'native_push',
      peers: connected ? [...this.recentPeers.values()] : [],
    }
  }

  async sendText(params: { to: string; text: string }): Promise<ChannelSendResult> {
    if (this.login.getStatus() !== 'connected') {
      return {
        ok: false,
        errorCode: 'CHANNEL_NOT_CONNECTED',
        message: 'QQ 机器人未连接，请先在设置中扫码接入',
        channel: 'qbot',
        to: params.to,
      }
    }
    const isGroup = params.to.startsWith('group:')
    const chatId = isGroup ? params.to.slice('group:'.length) : params.to
    const ok = await this.login.replyText(chatId, params.text, isGroup ? 'group' : 'p2p')
    return ok
      ? { ok: true, channel: 'qbot', to: params.to }
      : { ok: false, errorCode: 'UPSTREAM_ERROR', message: 'QQ 消息发送失败', channel: 'qbot', to: params.to }
  }

  async sendMedia(params: ChannelSendMediaParams): Promise<ChannelSendResult> {
    // 一期富媒体发送需先上传拿 file_info 再 msg_type=7；尚未实现时硬失败，不静默。
    return {
      ok: false,
      errorCode: 'UNSUPPORTED_MEDIA',
      message: 'QQ 富媒体发送暂未实现',
      channel: 'qbot',
      to: params.to,
    }
  }
}
