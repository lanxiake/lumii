/**
 * 用量统计服务 — 封装 window.electronAPI.usage 的薄层
 */

/** 到当前模型 provider 的首字节延迟（最近 N 次中位数，主进程侧已聚合） */
export async function getUsageLatency() {
  return window.electronAPI.usage.latency()
}
