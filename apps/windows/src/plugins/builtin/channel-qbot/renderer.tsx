import type { RendererPlugin } from '../../api'
import { QbotChannelSettings } from './ui/Settings'

/**
 * qbot 渠道的渲染层半边：设置 › 渠道 里的一张卡片。
 * 插件停用后条目注销，渠道分区里不再出现这张卡。
 */
export const channelQbotRenderer: RendererPlugin = {
  id: 'com.lumii.channel-qbot',
  setup(api) {
    return api.registerSlot('settings.channel.qbot', {
      id: 'channel.qbot.settings',
      component: QbotChannelSettings,
      order: 40,
      owner: 'com.lumii.channel-qbot',
    })
  },
}
