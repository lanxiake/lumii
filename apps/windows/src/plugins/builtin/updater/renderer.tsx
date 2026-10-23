import type { RendererPlugin } from '../../api'
import { UpdaterView } from './ui/UpdaterView'

const OWNER = 'com.lumii.updater'

/**
 * 自动更新的渲染层半边：设置 › 关于与更新 里的「软件更新」面板。
 *
 * 面板需要 `standalone` 布局，由宿主的槽位上下文传入（见 SettingsPage）。
 * 插件停用后槽位为空——卡片标题与「启动时检查」偏好仍留在核心，不影响其它设置。
 */
export const updaterRenderer: RendererPlugin = {
  id: OWNER,
  setup(api) {
    return api.registerSlot<{ standalone?: boolean }>('settings.section.updater', {
      id: 'updater.view',
      component: UpdaterView,
      order: 10,
      owner: OWNER,
    })
  },
}

export default updaterRenderer
