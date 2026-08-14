/**
 * 飞书出站 Provider：native_push，peer 为登录用户 openId。
 */

import type { FeishuLoginService } from '../../feishu-login-service'
import type {
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
    if (this.login.getStatus() !== 'connected') {
      return {
        ok: false,
        errorCode: 'CHANNEL_NOT_CONNECTED',
        message: '飞书未连接，请先在设置中扫码登录',
        channel: 'feishu',
        to: params.to,
      }
    }
    const res = await this.login.pushText(params.text, params.to)
    if (res.ok) {
      return { ok: true, channel: 'feishu', to: params.to }
    }
    return {
      ok: false,
      errorCode: 'UPSTREAM_ERROR',
      message: res.error ?? '飞书推送失败',
      channel: 'feishu',
      to: params.to,
    }
  }
}
