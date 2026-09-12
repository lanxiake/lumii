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
