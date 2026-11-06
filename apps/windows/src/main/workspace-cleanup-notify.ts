/**
 * 把「过期临时文件待确认」推到所有渲染窗口。
 * 主进程清理编排保持无 Electron 依赖；通知单独放这里。
 */

import { BrowserWindow } from 'electron'
import type { EphemeralCleanupPending } from './workspace-cleanup-runner'

/** 渲染层订阅的 IPC 通道名 */
export const EPHEMERAL_CLEANUP_PENDING_CHANNEL = 'workspace:cleanup:ephemeral-pending'

/** 有待清临时文件时广播；count≤0 则不发 */
export function notifyEphemeralCleanupPending(pending: EphemeralCleanupPending | undefined): void {
  if (!pending || pending.count <= 0) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(EPHEMERAL_CLEANUP_PENDING_CHANNEL, pending)
  }
}
