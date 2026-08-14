/**
 * 渠道出站统一路由：Agent / cron / 技能均经此 list / send。
 *
 * 硬失败：ok:false + 稳定 errorCode；禁止 silent success。
 */

import type { ChannelRegistry } from './channel-registry'
import type {
  ChannelSendParams,
  ChannelSendResult,
  ChannelSnapshot,
} from './outbound-types'

/**
 * 校验 to / 连接态 / peer 白名单后分发到对应 Provider。
 */
export class ChannelOutboundRouter {
  constructor(private readonly registry: ChannelRegistry) {}

  /**
   * 列出已注册渠道快照（含未连接渠道，便于 Agent 知晓能力）。
   */
  async list(): Promise<ChannelSnapshot[]> {
    const snaps: ChannelSnapshot[] = []
    for (const provider of this.registry.listProviders()) {
      snaps.push(await provider.getSnapshot())
    }
    return snaps
  }

  /**
   * 向指定 channel + to 发送文本；失败返回硬失败结果。
   */
  async send(params: ChannelSendParams): Promise<ChannelSendResult> {
    const channel = params.channel
    const to = typeof params.to === 'string' ? params.to.trim() : ''
    const text = typeof params.text === 'string' ? params.text : ''

    if (!to) {
      return {
        ok: false,
        errorCode: 'PEER_NOT_FOUND',
        message: '收件人 to 必填，请先调用 channel_list 获取 peer id',
        channel,
      }
    }

    const provider = this.registry.getProvider(channel)
    if (!provider) {
      return {
        ok: false,
        errorCode: 'CHANNEL_NOT_CONNECTED',
        message: `渠道 ${channel} 未注册或未初始化`,
        channel,
        to,
      }
    }

    const snapshot = await provider.getSnapshot()
    if (!snapshot.connected) {
      return {
        ok: false,
        errorCode: 'CHANNEL_NOT_CONNECTED',
        message: `渠道 ${channel} 未连接，请先在设置中完成登录`,
        channel,
        to,
      }
    }

    const peer = snapshot.peers.find((p) => p.id === to)
    if (!peer) {
      return {
        ok: false,
        errorCode: 'PEER_NOT_FOUND',
        message: `收件人 ${to} 不在 channel_list 返回的 peer 列表中，请先 list 再 send`,
        channel,
        to,
      }
    }

    const result = await provider.sendText({ to, text })
    return {
      ...result,
      channel: result.channel ?? channel,
      to: result.to ?? to,
    }
  }
}
