import type { RendererPlugin } from '../../api'
import { CloudSyncSection } from './ui/CloudSyncSection'

const OWNER = 'com.lumii.cloud-sync'

/**
 * 云同步的渲染层半边：设置里整块「云同步」。
 *
 * 停用插件（或卸载）后槽位为空，设置页显示一句「已禁用」提示；
 * 配置读写全走 `cloudSync:*` 通道，主进程半边停了这里也就没有可调的东西。
 *
 * 这是**仓库内**的渲染层半边（随主进程一起打 bundle），不是外部 `client.js`。
 */
export const cloudSyncRenderer: RendererPlugin = {
  id: OWNER,
  setup(api) {
    return api.registerSlot('settings.category.cloudSync', {
      id: 'cloud-sync.settings',
      component: CloudSyncSection,
      owner: OWNER,
    })
  },
}

export default cloudSyncRenderer
