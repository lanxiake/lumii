import type { RendererPlugin } from '../../api'
import { WeixinChannelSettings } from './ui/Settings'

/**
 * 个人微信渠道的渲染层半边：设置 › 渠道 里的一张卡片。
 *
 * 卡片由插件注册到 `settings.channel.weixin`；插件停用后条目注销，
 * 渠道设置分区里自然少这一张（不会留下一个点了就报错的连接按钮）。
 */
export const channelWeixinRenderer: RendererPlugin = {
  id: 'com.lumii.channel-weixin',
  setup(api) {
    return api.registerSlot('settings.channel.weixin', {
      id: 'channel.weixin.settings',
      component: WeixinChannelSettings,
      order: 10,
      owner: 'com.lumii.channel-weixin',
    })
  },
}
