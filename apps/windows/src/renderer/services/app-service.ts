/**
 * 应用服务 — 封装 window.electronAPI.app 的通用宿主能力（文件定位 / 拖拽路径）
 */

/** 在系统文件管理器中定位文件 */
export async function showItemInFolder(filePath: string): Promise<void> {
  await window.electronAPI.app.showItemInFolder(filePath)
}

/** 取拖拽 File 对象的本地真实路径（Electron webUtils） */
export function getPathForFile(file: File): string {
  return window.electronAPI.app.getPathForFile(file)
}
