import type { RendererPlugin } from '../../api'
import { ScreenRecordRoot, ScreenRecordTitleControl } from './ui'
import { ScreenRecordSettings } from './ui/ScreenRecordSettings'

const OWNER = 'com.lumii.screen-record'

/**
 * 录屏的渲染层半边。
 *
 * 两块 UI 挂在宿主的不同位置：
 * - `app.titlebar.actions`：顶栏按钮（与宠物模式开关并排）；
 * - `app.overlay`：面板与确认弹窗（`position:fixed`，挂在外层避免被裁切）。
 *
 * 两份 UI 订阅同一个模块级 store（`ui/useScreenRecord.ts`），所以不需要 Provider；
 * 停用插件时条目一起注销，订阅计数归零后 IPC 事件与计时器自动停。
 *
 * 注意：这是**仓库内**的渲染层半边（随主进程一起打 bundle），不是外部 `client.js`；
 * 官方外部扩展的 client 半边尚未纳入打包流水线（见 plugins/README.md）。
 */
export const screenRecordRenderer: RendererPlugin = {
  id: OWNER,
  setup(api) {
    const disposers = [
      api.registerSlot('app.titlebar.actions', {
        id: 'screen-record.title-control',
        component: ScreenRecordTitleControl,
        order: 10,
        owner: OWNER,
      }),
      api.registerSlot('app.overlay', {
        id: 'screen-record.root',
        component: ScreenRecordRoot,
        owner: OWNER,
      }),
      api.registerSlot('settings.category.screenRecord', {
        id: 'screen-record.settings',
        component: ScreenRecordSettings,
        order: 10,
        owner: OWNER,
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  },
}

export default screenRecordRenderer
