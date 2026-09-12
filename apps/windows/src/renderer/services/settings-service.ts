/**
 * 设置同步服务 — 封装 window.electronAPI.settings 的薄层
 */

/** 同步记忆注入开关到主进程缓存（非关键路径，失败由调用方酌情忽略） */
export async function updateMemoryInjection(config: {
  injectPersonalMemory?: boolean
  injectWorkMemory?: boolean
}): Promise<void> {
  await window.electronAPI?.settings?.updateMemoryInjection?.(config)
}
