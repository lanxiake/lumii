import type { RendererPlugin } from '../../api'
import { FeishuChannelSettings } from './ui/Settings'

/**
 * feishu 渠道的渲染层半边：设置 › 渠道 里的一张卡片。
 * 插件停用后条目注销，渠道分区里不再出现这张卡。
 */
export const channelFeishuRenderer: RendererPlugin = {
  id: 'com.lumii.channel-feishu',
  setup(api) {
    return api.registerSlot('settings.channel.feishu', {
      id: 'channel.feishu.settings',
      component: FeishuChannelSettings,
      order: 30,
      owner: 'com.lumii.channel-feishu',
    })
  },
}
