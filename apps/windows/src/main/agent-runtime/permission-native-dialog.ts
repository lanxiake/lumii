/**
 * 渲染进程不可达时，用 Electron 原生对话框完成工具权限确认。
 */

import { dialog, type BrowserWindow } from 'electron'

export type NativePermissionDecision = 'allow-once' | 'allow-always' | 'deny'

/**
 * 弹出系统级工具权限确认框（主进程兜底，避免 IPC 失败导致 30s 超时拒绝）。
 */
export async function showNativeToolPermissionDialog(options: {
  parent: BrowserWindow | null
  toolName: string
  description: string
}): Promise<NativePermissionDecision> {
  const parent = options.parent
  if (parent && !parent.isDestroyed()) {
    parent.show()
    parent.focus()
  }

  const messageBoxOptions: Electron.MessageBoxOptions = {
    type: 'question',
    title: '工具执行确认',
    message: `Agent 请求执行：${options.toolName}`,
    detail: `${options.description}\n\n是否允许？`,
    buttons: ['拒绝', '仅本次允许', '始终允许'],
    defaultId: 1,
    cancelId: 0,
  }

  // showMessageBox 的两个重载不接受 parent 为 undefined，按分支调用
  const result = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, messageBoxOptions)
    : await dialog.showMessageBox(messageBoxOptions)

  if (result.response === 0) return 'deny'
  if (result.response === 2) return 'allow-always'
  return 'allow-once'
}
