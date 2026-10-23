import type { RendererPlugin } from '../../api'
import { VoiceSettingsSection } from './ui/VoiceSettingsSection'

/**
 * 语音的渲染层半边：设置 › 语音设置 整块。
 *
 * 插件停用 → 槽位里没有条目 → 分区内容为空、左侧入口消失
 * （映射见 `plugins/renderer/settings-categories.ts`）。
 */
export const voiceRenderer: RendererPlugin = {
  id: 'com.lumii.voice',
  setup(api) {
    return api.registerSlot('settings.category.voice', {
      id: 'voice.settings',
      component: VoiceSettingsSection,
      owner: 'com.lumii.voice',
    })
  },
}
