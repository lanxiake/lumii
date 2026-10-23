import type { RendererPlugin } from '../../api'
import { SelectionLayer } from './ui/SelectionLayer'

const OWNER = 'com.lumii.selection'

/**
 * 划词动作的渲染层半边：全局浮条 / 菜单 / 结果气泡。
 *
 * 挂在 `app.overlay`（最外层，避免被子页面的层叠上下文裁掉）；
 * 插件停用后条目注销，选区监听与 IPC 调用随组件卸载一起停。
 */
export const selectionRenderer: RendererPlugin = {
  id: OWNER,
  setup(api) {
    return api.registerSlot('app.overlay', {
      id: 'selection.layer',
      component: SelectionLayer,
      order: 100,
      owner: OWNER,
    })
  },
}

export default selectionRenderer
