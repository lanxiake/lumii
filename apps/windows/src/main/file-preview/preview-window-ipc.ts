/**
 * 文件预览独立窗口 IPC 注册
 */

import { ipcMain } from 'electron'
import {
  FILE_PREVIEW_IPC,
  type FilePreviewWindowPayload,
} from '../../shared/file-preview-window'
import {
  PreviewWindowManager,
  type PreviewWindowManagerDeps,
} from './preview-window-manager'

let manager: PreviewWindowManager | null = null
let registered = false

/** 供其它模块取管理器（可选） */
export function getPreviewWindowManager(): PreviewWindowManager | null {
  return manager
}

/**
 * 注册 file-preview:* IPC，并初始化 PreviewWindowManager
 */
export function registerFilePreviewWindowIpc(deps: PreviewWindowManagerDeps): void {
  if (registered) {
    console.warn('[PreviewWindowIpc] 已注册，跳过')
    return
  }
  registered = true
  manager = new PreviewWindowManager(deps)

  ipcMain.handle(FILE_PREVIEW_IPC.open, async (_evt, payload: FilePreviewWindowPayload) => {
    if (!payload?.fileName || (!payload.fileId && !payload.filePath)) {
      throw new Error('file-preview:open 需要 fileName 与 fileId/filePath')
    }
    await manager!.open(payload)
    return { ok: true as const }
  })

  ipcMain.handle(FILE_PREVIEW_IPC.close, () => {
    manager?.close()
    return { ok: true as const }
  })

  ipcMain.handle(FILE_PREVIEW_IPC.getPayload, () => manager?.getPayload() ?? null)
}
