/**
 * 飞书出站 Provider：native_push，peer 为登录用户 openId。
 */

import type { FeishuLoginService } from '../../feishu-login-service'
import type {
  ChannelSendMediaParams,
  ChannelSendResult,
  ChannelSnapshot,
  IChannelOutboundProvider,
} from '../outbound-types'

/**
 * 包装 FeishuLoginService.pushText；list 仅暴露已知 openId。
 */
export class FeishuChannelProvider implements IChannelOutboundProvider {
  readonly channel = 'feishu' as const

  constructor(private readonly login: FeishuLoginService) {}

  /**
   * 返回连接态与默认 peer（扫码用户本人）。
   */
  getSnapshot(): ChannelSnapshot {
    const connected = this.login.getStatus() === 'connected'
    const openId = this.login.getSessionPublic()?.openId
    const peers =
      connected && openId
        ? [{ id: openId, label: '我', canSend: true as const }]
        : []
    return {
      channel: 'feishu',
      connected,
      pushMode: 'native_push',
      peers,
    }
  }

  /**
   * 向指定 open_id 推送文本。
   */
  async sendText(params: { to: string; text: string }): Promise<ChannelSendResult> {
    const blocked = this.checkConnected(params.to)
    if (blocked) return blocked
    return this.toResult(params.to, await this.login.pushText(params.text, params.to), '飞书推送失败')
  }

  /**
   * 向指定 open_id 推送本地文件；有随附文本时先发文本再发文件。
   */
  async sendMedia(params: ChannelSendMediaParams): Promise<ChannelSendResult> {
    const blocked = this.checkConnected(params.to)
    if (blocked) return blocked
    // 图片/文件消息不带正文，说明性文字需独立成条
    if (params.text?.trim()) {
      const textRes = await this.login.pushText(params.text, params.to)
      if (!textRes.ok) {
        return this.toResult(params.to, textRes, '飞书随附文本发送失败，已中止文件发送')
      }
    }
    const res = await this.login.pushMedia(params.mediaPath, params.to, params.fileName)
    return this.toResult(params.to, res, '飞书文件推送失败')
  }

  /**
   * 未连接时返回硬失败结果，已连接返回 null。
   */
  private checkConnected(to: string): ChannelSendResult | null {
    if (this.login.getStatus() === 'connected') return null
    return {
      ok: false,
      errorCode: 'CHANNEL_NOT_CONNECTED',
      message: '飞书未连接，请先在设置中扫码登录',
      channel: 'feishu',
      to,
    }
  }

  /**
   * 将 LoginService 的 {ok,error} 归一成渠道出站结果。
   */
  private toResult(
    to: string,
    res: { ok: boolean; error?: string },
    fallbackMessage: string,
  ): ChannelSendResult {
    if (res.ok) return { ok: true, channel: 'feishu', to }
    return {
      ok: false,
      errorCode: 'UPSTREAM_ERROR',
      message: res.error ?? fallbackMessage,
      channel: 'feishu',
      to,
    }
  }
}
