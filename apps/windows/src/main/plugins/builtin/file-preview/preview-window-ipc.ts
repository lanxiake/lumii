/**
 * 文件预览独立窗口 IPC 注册
 */

import { ipcMain } from 'electron'
import {
  FILE_PREVIEW_IPC,
  type FilePreviewWindowPayload,
} from '../../../../shared/file-preview-window'
import {
  PreviewWindowManager,
  type PreviewWindowManagerDeps,
} from './preview-window-manager'
import type { IpcHandleRegistrar } from '../../../kernel/ipc-registry'

/**
 * 注册 file-preview:* IPC，并创建一个 PreviewWindowManager。
 *
 * 管理器**不再挂在模块级**：插件禁用时要把窗口关掉、处理器摘掉，重新启用时再建一套。
 * 以前用模块级单例 + `registered` 标志，第二次注册会被「已注册」挡掉，
 * 那是「只能重启恢复」的根。
 *
 * 返回的 `dispose` 由插件接进 `ctx.effect`。
 */
export function registerFilePreviewWindowIpc(
  deps: PreviewWindowManagerDeps,
  registrar: IpcHandleRegistrar = ipcMain as unknown as IpcHandleRegistrar,
): { dispose(): void } {
  const manager = new PreviewWindowManager(deps)

  registrar.handle(FILE_PREVIEW_IPC.open, async (_evt, payload: FilePreviewWindowPayload) => {
    if (!payload?.fileName || (!payload.fileId && !payload.filePath)) {
      throw new Error('file-preview:open 需要 fileName 与 fileId/filePath')
    }
    await manager.open(payload)
    return { ok: true as const }
  })

  registrar.handle(FILE_PREVIEW_IPC.close, () => {
    manager.close()
    return { ok: true as const }
  })

  registrar.handle(FILE_PREVIEW_IPC.getPayload, () => manager.getPayload() ?? null)

  return { dispose: () => manager.close() }
}
