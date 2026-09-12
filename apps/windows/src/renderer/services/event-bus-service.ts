/**
 * 主进程事件总线服务 — 封装 window.electronAPI.on/off 的通用订阅
 */

/** 订阅主进程事件；返回取消订阅函数 */
export function subscribeMainEvent(
  channel: string,
  handler: (...args: unknown[]) => void,
): () => void {
  window.electronAPI.on(channel, handler)
  return () => window.electronAPI.off(channel, handler)
}
