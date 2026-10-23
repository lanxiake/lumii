import type { RendererPlugin } from '../../api'
import { WecomChannelSettings } from './ui/Settings'

/**
 * wecom 渠道的渲染层半边：设置 › 渠道 里的一张卡片。
 * 插件停用后条目注销，渠道分区里不再出现这张卡。
 */
export const channelWecomRenderer: RendererPlugin = {
  id: 'com.lumii.channel-wecom',
  setup(api) {
    return api.registerSlot('settings.channel.wecom', {
      id: 'channel.wecom.settings',
      component: WecomChannelSettings,
      order: 20,
      owner: 'com.lumii.channel-wecom',
    })
  },
}
