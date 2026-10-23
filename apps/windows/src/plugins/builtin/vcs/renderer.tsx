import type { RendererPlugin } from '../../api'
import { WorkspaceVersionPanel } from './ui/WorkspaceVersionPanel/WorkspaceVersionPanel'

/**
 * 工作空间版本管理的渲染层半边：对话页工作台里的「版本」页签。
 *
 * 面板由插件注册到 `workspace.version`；插件停用时条目注销，
 * 工作台不再显示「版本」页签（快照也就没有入口可回滚）。
 */
export const vcsRenderer: RendererPlugin = {
  id: 'com.lumii.vcs',
  setup(api) {
    return api.registerSlot('workspace.version', {
      id: 'vcs.version-panel',
      component: WorkspaceVersionPanel,
      owner: 'com.lumii.vcs',
    })
  },
}
