import { ipcMain } from 'electron'

import { getExtensionControl } from '../extension-control'
import { createSamplePlugin } from '../plugin-template'

/**
 * 设置页「扩展」页签的数据面。
 *
 * 只有四个通道：列表、两个开关、生成示例。**不加**运行日志/内存之类的通道——
 * 那些在日志与 `/status` 里已经有了，抄一遍到 UI 只是装饰。
 *
 * 开关的生效时机不同（主进程要重启、客户端插件 ≤1 秒），返回里带
 * `restartRequired`，由 UI 负责如实显示。
 */
export function setupExtensionIpcHandlers(): void {
  ipcMain.handle('extension:list', () => getExtensionControl()?.list() ?? [])

  ipcMain.handle('extension:set-enabled', (_event, id: string, enabled: boolean) => {
    const control = getExtensionControl()
    if (!control) return { ok: false, error: '扩展宿主尚未就绪' }
    return control.setEnabled(id, enabled)
  })

  ipcMain.handle('extension:set-client-enabled', (_event, id: string, enabled: boolean) => {
    const control = getExtensionControl()
    if (!control) return { ok: false, error: '扩展宿主尚未就绪' }
    return control.setClientEnabled(id, enabled)
  })

  ipcMain.handle('extension:create-sample', () => createSamplePlugin())
}
