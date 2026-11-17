/**
 * 主进程事件总线服务 — 封装 window.electronAPI.on/off 的通用订阅
 */

/** 订阅主进程事件；返回取消订阅函数 */
export function subscribeMainEvent(
  channel: string,
  handler: (...args: unknown[]) => void,
): () => void {
  // preload 未注入时 electronAPI 整个不存在（如开发态 HMR 重载后）。
  // 这里抛错会在 App 的 effect 里炸掉整个界面，降级成"没有主进程事件"即可。
  const api = window.electronAPI
  if (!api?.on || !api.off) return () => {}
  api.on(channel, handler)
  return () => api.off(channel, handler)
}
