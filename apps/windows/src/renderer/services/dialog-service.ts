/**
 * 对话框服务 — 封装 window.electronAPI.dialog 的通用选择器
 */

/**
 * 打开系统目录选择对话框，返回选中的第一个目录；取消返回 null。
 * 对话框自身失败向调用方抛出（原调用点负责提示错误）。
 */
export async function pickDirectory(options?: { title?: string; buttonLabel?: string }): Promise<string | null> {
  const result = await window.electronAPI.dialog.showOpenDialog({
    properties: ['openDirectory'],
    ...options,
  })
  return !result.canceled && result.filePaths.length > 0 ? result.filePaths[0] : null
}

/**
 * 打开系统保存对话框，返回目标路径；取消或接口不可用返回 null。
 * 对话框自身失败向调用方抛出（原调用点负责提示错误）。
 */
export async function saveFile(options: { defaultPath?: string } = {}): Promise<string | null> {
  const result = await window.electronAPI.dialog?.showSaveDialog?.(options)
  return result?.filePath ?? null
}
