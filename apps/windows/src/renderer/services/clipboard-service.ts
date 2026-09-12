/**
 * 剪贴板服务 — 封装 window.electronAPI.clipboard 的薄层
 */

/** 写入文本到系统剪贴板 */
export async function writeClipboardText(text: string): Promise<void> {
  await window.electronAPI.clipboard.writeText(text)
}

/** 将文件对象写入剪贴板，可在资源管理器/聊天框直接粘贴出文件 */
export async function writeClipboardFiles(filePaths: string[]): Promise<void> {
  await window.electronAPI.clipboard.writeFiles(filePaths)
}
