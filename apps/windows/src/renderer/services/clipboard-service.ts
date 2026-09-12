/**
 * 剪贴板服务 — 封装 window.electronAPI.clipboard 的薄层
 */

/** 写入文本到系统剪贴板 */
export async function writeClipboardText(text: string): Promise<void> {
  await window.electronAPI.clipboard.writeText(text)
}
