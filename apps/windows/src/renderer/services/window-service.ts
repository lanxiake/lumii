/**
 * 窗口控制服务 — 封装 window.electronAPI.window 的薄层
 */

/** 最小化窗口 */
export function minimizeWindow(): void {
  window.electronAPI.window.minimize()
}

/** 最大化/还原窗口 */
export function maximizeWindow(): void {
  window.electronAPI.window.maximize()
}

/** 关闭窗口 */
export function closeWindow(): void {
  window.electronAPI.window.close()
}

/** 查询窗口是否最大化；主进程 API 不可用时返回 null（调用方自行兜底） */
export async function isWindowMaximized(): Promise<boolean | null> {
  const api = window.electronAPI?.window
  if (api && typeof api.isMaximized === 'function') {
    return api.isMaximized()
  }
  return null
}

/** 光标相对窗口内容区坐标（穿透标题栏 drag 区）；不可用时返回 null */
export async function getCursorClientPos(): Promise<{
  x: number
  y: number
  inside: boolean
} | null> {
  const api = window.electronAPI?.window
  if (!api || typeof api.getCursorClientPos !== 'function') return null
  return api.getCursorClientPos()
}
