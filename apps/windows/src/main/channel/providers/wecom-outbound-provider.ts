/**
 * 企微出站 Provider：一期 reply_only，主动 send 恒硬失败 UNSUPPORTED_PUSH。
 */

import type { WecomLoginService } from '../../wecom-login-service'
import type {
  ChannelPeer,
  ChannelSendMediaParams,
  ChannelSendResult,
  ChannelSnapshot,
  IChannelOutboundProvider,
} from '../outbound-types'

/**
 * 可选记录最近入站 peer 供 list；send 一律不支持主动推送。
 */
export class WecomChannelProvider implements IChannelOutboundProvider {
  readonly channel = 'wecom' as const
  private readonly recentPeers = new Map<string, ChannelPeer>()

  constructor(private readonly login: WecomLoginService) {}

  /**
   * 记录最近入站用户（可选 label），供 channel_list 展示。
   */
  rememberInboundPeer(channelUserId: string, label?: string): void {
    const id = channelUserId.trim()
    if (!id) return
    this.recentPeers.set(id, {
      id,
      ...(label ? { label } : {}),
      canSend: false,
      blockedReason: 'UNSUPPORTED',
      lastInboundAt: Date.now(),
    })
  }

  /**
   * 返回连接态与最近入站 peers（均不可主动发送）。
   */
  getSnapshot(): ChannelSnapshot {
    const connected = this.login.getStatus() === 'connected'
    return {
      channel: 'wecom',
      connected,
      pushMode: 'reply_only',
      peers: connected ? [...this.recentPeers.values()] : [],
    }
  }

  /**
   * 一期不对企微做伪 Push。
   */
  async sendText(params: { to: string; text: string }): Promise<ChannelSendResult> {
    return this.unsupported(params.to)
  }

  /**
   * 主动推送不可用，富媒体同样不支持。
   */
  async sendMedia(params: ChannelSendMediaParams): Promise<ChannelSendResult> {
    return this.unsupported(params.to)
  }

  /**
   * 统一的「企微不支持主动推送」硬失败结果。
   */
  private unsupported(to: string): ChannelSendResult {
    return {
      ok: false,
      errorCode: 'UNSUPPORTED_PUSH',
      message: '企业微信当前仅支持会话内被动回复，不支持主动推送',
      channel: 'wecom',
      to,
    }
  }
}
