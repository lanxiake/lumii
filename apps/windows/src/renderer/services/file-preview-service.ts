/**
 * 文件预览独立窗口服务 — 封装 window.electronAPI.filePreview 的薄层
 */

import type { FilePreviewWindowPayload } from '../../shared/file-preview-window'

/** 打开（或聚焦）独立预览窗 */
export async function openFilePreviewWindow(
  payload: FilePreviewWindowPayload,
): Promise<{ ok: boolean }> {
  return window.electronAPI.filePreview.open(payload)
}

/** 关闭独立预览窗 */
export async function closeFilePreviewWindow(): Promise<{ ok: boolean }> {
  return window.electronAPI.filePreview.close()
}

/** 拉取当前预览载荷（独立窗渲染层启动时用） */
export async function getFilePreviewPayload(): Promise<FilePreviewWindowPayload | null> {
  return window.electronAPI.filePreview.getPayload()
}

/** 订阅载荷更新；返回取消订阅函数 */
export function onFilePreviewPayloadUpdated(
  callback: (payload: FilePreviewWindowPayload | null) => void,
): () => void {
  return window.electronAPI.filePreview.onPayloadUpdated(callback)
}

/**
 * 在独立预览窗内左右切换相邻文件。
 *
 * **清单在主进程**：它随 open 的载荷一起过去（预览窗是另一个 BrowserWindow，
 * 够不到主窗的产物台账）。这里只发方向。
 */
export async function navigateFilePreviewWindow(direction: -1 | 1): Promise<boolean> {
  const result = await window.electronAPI.filePreview.navigate(direction)
  return result?.ok === true
}
