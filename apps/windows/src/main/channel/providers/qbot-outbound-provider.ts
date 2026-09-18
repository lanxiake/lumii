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

  /**
   * 启动时恢复最近入站 peer（持久化层只保住被动回复窗口内的记录）。
   *
   * 只改写 lastInboundAt：发送时是否走被动回复由 LoginService 的入站窗口自判，
   * 超窗会降级主动推送并如实报错，这里不按时间过滤，避免 list 与 send 口径不一。
   */
  setSnapshotRestore(peers: readonly ChannelPeer[]): void {
    for (const peer of peers) {
      const id = peer.id.trim()
      if (!id) continue
      this.recentPeers.set(id, { ...peer, id, lastInboundAt: Date.now() })
    }
  }

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

  async sendText(params: { to: string; text: string; title?: string }): Promise<ChannelSendResult> {
    if (this.login.getStatus() !== 'connected') {
      return {
        ok: false,
        errorCode: 'CHANNEL_NOT_CONNECTED',
        message: 'QQ 机器人未连接，请先在设置中扫码接入',
        channel: 'qbot',
        to: params.to,
      }
    }
    // Router 的 peers 白名单校验以本快照为数据源，对「不在最近入站记录里的 to」是空校验；
    // 真正兜底在这里：只允许回复最近入站过的 peer（被动回复窗口语义）
    if (!this.recentPeers.has(params.to)) {
      return {
        ok: false,
        errorCode: 'PEER_NOT_FOUND',
        message: `QQ 最近没有来自 ${params.to} 的消息，无法投递；请让用户在 QQ 里给机器人发一条消息`,
        channel: 'qbot',
        to: params.to,
      }
    }
    const isGroup = params.to.startsWith('group:')
    const chatId = isGroup ? params.to.slice('group:'.length) : params.to
    // Markdown 由登录层编译为单条（被动回复窗口内条数有限）；
    // 平台未开通 markdown 时登录层自动降级纯文本
    const ok = await this.login.replyMarkdown(chatId, params.text, isGroup ? 'group' : 'p2p', params.title)
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
