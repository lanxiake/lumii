import type { RendererPlugin } from '../../api'
import { PcwechatChannelSettings } from './ui/Settings'

/**
 * 本机微信渠道的渲染层半边：设置 › 渠道 里的一张卡片。
 * 插件停用后条目注销，渠道分区里不再出现这张卡。
 */
export const pcwechatRenderer: RendererPlugin = {
  id: 'com.lumii.pcwechat',
  setup(api) {
    return api.registerSlot('settings.channel.pcwechat', {
      id: 'channel.pcwechat.settings',
      component: PcwechatChannelSettings,
      order: 50,
      owner: 'com.lumii.pcwechat',
    })
  },
}
