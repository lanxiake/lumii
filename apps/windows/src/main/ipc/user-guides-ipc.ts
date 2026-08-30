/**
 * 内置使用指南 IPC
 */

import { ipcMain } from 'electron'
import { listBundledUserGuides, readBundledUserGuide } from '../user-guides/user-guides-service'

/**
 * 注册内置指南 list/read IPC。
 */
export function registerUserGuidesIpcHandlers(): void {
  ipcMain.handle('app:guides:list', () => listBundledUserGuides())

  ipcMain.handle('app:guides:read', (_event, guideId: string) => {
    if (typeof guideId !== 'string' || guideId.trim().length === 0) {
      throw new Error('guideId 不能为空')
    }
    return readBundledUserGuide(guideId.trim())
  })
}
