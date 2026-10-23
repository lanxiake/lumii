import type { RendererPlugin } from '../../api'
import { UsagePanel } from './ui/UsagePanel'

/**
 * 用量统计的渲染层半边：设置 › 用量 的分区内容。
 *
 * 分区**整块由插件注册**（`settings.category.usage`）：插件禁用时槽位里没有条目，
 * 设置页的「用量」入口也会一起消失（见 `plugins/renderer/settings-categories.ts`）。
 */
export const usageRenderer: RendererPlugin = {
  id: 'com.lumii.usage',
  setup(api) {
    return api.registerSlot('settings.category.usage', {
      id: 'usage.panel',
      component: UsagePanel,
      owner: 'com.lumii.usage',
    })
  },
}
