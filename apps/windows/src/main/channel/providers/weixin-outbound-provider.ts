/**
 * 微信出站 Provider：cached_reply，依赖 WeixinReplyContextStore 中的 context_token。
 */

import type { WeixinLoginService } from '../../weixin-login-service'
import type { WeixinReplyContextStore } from '../weixin-reply-context-store'
import type {
  ChannelPeer,
  ChannelSendMediaParams,
  ChannelSendResult,
  ChannelSnapshot,
  IChannelOutboundProvider,
  WeixinReplyContextRecord,
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
   * 出站前置校验：登录态 + 该 peer 的 reply context。
   * 通过返回 record，未通过返回可直接上抛的硬失败结果。
   */
  private resolveOutboundContext(
    to: string,
  ): { record: WeixinReplyContextRecord } | { failure: ChannelSendResult } {
    if (this.login.getStatus() !== 'logged_in') {
      return {
        failure: {
          ok: false,
          errorCode: 'CHANNEL_NOT_CONNECTED',
          message: '微信未登录，请先在设置中扫码登录',
          channel: 'weixin',
          to,
        },
      }
    }
    const record = this.store.get(to)
    if (!record?.contextToken) {
      return {
        failure: {
          ok: false,
          errorCode: 'NO_REPLY_CONTEXT',
          message: '该微信用户尚未给 Bot 发过消息，请先让对方发任意一条以激活出站',
          channel: 'weixin',
          to,
        },
      }
    }
    return { record }
  }

  /**
   * 将上游 boolean / 异常统一转成硬失败结果。
   */
  private toResult(to: string, ok: boolean, failMessage: string): ChannelSendResult {
    if (ok) return { ok: true, channel: 'weixin', to }
    return {
      ok: false,
      errorCode: 'UPSTREAM_ERROR',
      message: failMessage,
      channel: 'weixin',
      to,
    }
  }

  /**
   * 用持久化 token 调用 sendTextReply；失败硬失败。
   */
  async sendText(params: { to: string; text: string }): Promise<ChannelSendResult> {
    const ctx = this.resolveOutboundContext(params.to)
    if ('failure' in ctx) return ctx.failure
    const rec = ctx.record
    try {
      const ok = await this.login.sendTextReply(
        params.to,
        params.text,
        rec.contextToken,
        rec.botToken,
        rec.ilinkBaseUrl,
      )
      return this.toResult(
        params.to,
        ok,
        '微信发送失败，可能是 token 已失效，请让用户再发一条消息后重试',
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return this.toResult(params.to, false, msg)
    }
  }

  /**
   * 发送本地文件（图片/文档/音视频）；有随附文本时先发文本再发文件。
   */
  async sendMedia(params: ChannelSendMediaParams): Promise<ChannelSendResult> {
    const ctx = this.resolveOutboundContext(params.to)
    if ('failure' in ctx) return ctx.failure
    const rec = ctx.record
    try {
      // 文本先行：iLink 媒体消息不携带正文，说明性文字需独立成条
      if (params.text?.trim()) {
        const textOk = await this.login.sendTextReply(
          params.to,
          params.text,
          rec.contextToken,
          rec.botToken,
          rec.ilinkBaseUrl,
        )
        if (!textOk) {
          return this.toResult(params.to, false, '微信随附文本发送失败，已中止文件发送')
        }
      }
      const ok = await this.login.sendMediaReply(
        params.to,
        params.mediaPath,
        params.fileName,
        rec.contextToken,
        rec.botToken,
        rec.ilinkBaseUrl,
      )
      return this.toResult(
        params.to,
        ok,
        '微信文件发送失败，可能是 token 已失效或文件过大，请让用户再发一条消息后重试',
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return this.toResult(params.to, false, msg)
    }
  }
}
