/**
 * 微信出站 Provider：cached_reply，依赖 WeixinReplyContextStore 中的 context_token。
 */

import type { WeixinLoginService } from '../../weixin-login-service'
import type { WeixinReplyContextStore } from '../weixin-reply-context-store'
import type {
  ChannelPeer,
  ChannelSendResult,
  ChannelSnapshot,
  IChannelOutboundProvider,
} from '../outbound-types'

/**
 * 入站 upsert token 后才能主动 send；无 token → NO_REPLY_CONTEXT。
 */
export class WeixinChannelProvider implements IChannelOutboundProvider {
  readonly channel = 'weixin' as const

  constructor(
    private readonly login: WeixinLoginService,
    private readonly store: WeixinReplyContextStore,
  ) {}

  /**
   * 列出 store 中全部 peer；stale 标 canSend=false。
   */
  getSnapshot(): ChannelSnapshot {
    const connected = this.login.getStatus() === 'logged_in'
    const now = Date.now()
    const peers: ChannelPeer[] = this.store.list().map((rec) => {
      const stale = this.store.isStale(rec.channelUserId, now)
      const hasToken = Boolean(rec.contextToken)
      if (!hasToken) {
        return {
          id: rec.channelUserId,
          ...(rec.lastNickname ? { label: rec.lastNickname } : {}),
          canSend: false,
          blockedReason: 'NO_REPLY_CONTEXT' as const,
          lastInboundAt: rec.updatedAt,
        }
      }
      if (stale) {
        return {
          id: rec.channelUserId,
          ...(rec.lastNickname ? { label: rec.lastNickname } : {}),
          canSend: false,
          blockedReason: 'TOKEN_STALE' as const,
          lastInboundAt: rec.updatedAt,
        }
      }
      return {
        id: rec.channelUserId,
        ...(rec.lastNickname ? { label: rec.lastNickname } : {}),
        canSend: true,
        lastInboundAt: rec.updatedAt,
      }
    })
    return {
      channel: 'weixin',
      connected,
      pushMode: 'cached_reply',
      peers: connected ? peers : [],
    }
  }

  /**
   * 用持久化 token 调用 sendTextReply；失败硬失败。
   */
  async sendText(params: { to: string; text: string }): Promise<ChannelSendResult> {
    if (this.login.getStatus() !== 'logged_in') {
      return {
        ok: false,
        errorCode: 'CHANNEL_NOT_CONNECTED',
        message: '微信未登录，请先在设置中扫码登录',
        channel: 'weixin',
        to: params.to,
      }
    }
    const rec = this.store.get(params.to)
    if (!rec?.contextToken) {
      return {
        ok: false,
        errorCode: 'NO_REPLY_CONTEXT',
        message: '该微信用户尚未给 Bot 发过消息，请先让对方发任意一条以激活出站',
        channel: 'weixin',
        to: params.to,
      }
    }
    try {
      const ok = await this.login.sendTextReply(
        params.to,
        params.text,
        rec.contextToken,
        rec.botToken,
        rec.ilinkBaseUrl,
      )
      if (ok) {
        return { ok: true, channel: 'weixin', to: params.to }
      }
      return {
        ok: false,
        errorCode: 'UPSTREAM_ERROR',
        message: '微信发送失败，可能是 token 已失效，请让用户再发一条消息后重试',
        channel: 'weixin',
        to: params.to,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        errorCode: 'UPSTREAM_ERROR',
        message: msg,
        channel: 'weixin',
        to: params.to,
      }
    }
  }
}
