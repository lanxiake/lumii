import type { RendererPlugin } from '../../api'
import { PetModeTitleControl } from './ui/PetModeTitleControl'
import { PetSettingsSection } from './ui/PetSettingsSection'

/**
 * 桌宠的渲染层半边：设置 › 宠物 整块。
 *
 * 桌宠窗口（`?mode=pet`）由主进程打开，插件停用时窗口根本不会创建；
 * 标题栏开关（`PetModeTitleControl`）用 `usePluginEnabled('com.lumii.pet')` 自行隐藏。
 * 这里只负责设置分区——停用后槽位为空、左侧入口一起消失。
 */
export const petRenderer: RendererPlugin = {
  id: 'com.lumii.pet',
  setup(api) {
    const offSettings = api.registerSlot('settings.category.pet', {
      id: 'pet.settings',
      component: PetSettingsSection,
      owner: 'com.lumii.pet',
    })
    // 标题栏开关：与录屏并排；停用后条目注销、按钮一起消失
    const offTitle = api.registerSlot('app.titlebar.actions', {
      id: 'pet.title-control',
      component: PetModeTitleControl,
      order: 20,
      owner: 'com.lumii.pet',
    })
    return () => {
      offSettings()
      offTitle()
    }
  },
}
