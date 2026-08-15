/**
 * 文件预览独立窗口 — 共享类型与 IPC 契约
 *
 * 独立 BrowserWindow 可拖出主窗口外，便于对照查看与缩放。
 */

/** 打开预览窗时传入的载荷 */
export interface FilePreviewWindowPayload {
  fileName: string
  fileId?: string
  filePath?: string
  userId?: string
  startLine?: number
  endLine?: number
  mdBasePath?: string
  editablePath?: string
}

/** file-preview IPC 通道名 */
export const FILE_PREVIEW_IPC = {
  /** invoke：打开或聚焦独立预览窗 */
  open: 'file-preview:open',
  /** invoke：关闭独立预览窗 */
  close: 'file-preview:close',
  /** invoke：预览窗渲染层拉取当前载荷 */
  getPayload: 'file-preview:get-payload',
} as const
