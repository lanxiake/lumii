/**
 * 渠道出站注册表：聚合各 Provider 的连接态与 peers。
 */

import type { IChannelOutboundProvider, OutboundChannelId } from './outbound-types'

/**
 * 内存注册表；LoginService 不搬迁，经 Provider.register 接入。
 */
export class ChannelRegistry {
  private readonly providers = new Map<OutboundChannelId, IChannelOutboundProvider>()

  /**
   * 注册或覆盖某渠道的出站 Provider。
   */
  register(provider: IChannelOutboundProvider): void {
    this.providers.set(provider.channel, provider)
  }

  /**
   * 按渠道取 Provider；未注册返回 undefined。
   */
  getProvider(channel: OutboundChannelId): IChannelOutboundProvider | undefined {
    return this.providers.get(channel)
  }

  /**
   * 返回已注册的全部 Provider（固定 feishu → weixin → wecom 顺序优先）。
   */
  listProviders(): IChannelOutboundProvider[] {
    const order: OutboundChannelId[] = ['feishu', 'weixin', 'wecom']
    const result: IChannelOutboundProvider[] = []
    for (const id of order) {
      const p = this.providers.get(id)
      if (p) result.push(p)
    }
    for (const [id, p] of this.providers) {
      if (!order.includes(id)) result.push(p)
    }
    return result
  }
}
