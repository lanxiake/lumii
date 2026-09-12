/**
 * 用量统计服务 — 封装 window.electronAPI.usage 的薄层
 */

/** 到当前模型 provider 的首字节延迟（最近 N 次中位数，主进程侧已聚合） */
export async function getUsageLatency() {
  return window.electronAPI.usage.latency()
}

/** 查询指定区间（epoch ms）的用量统计；失败抛出中文错误 */
export async function queryUsage(params: { from: number; to: number; groupBy: 'hour' | 'day' }) {
  const res = await window.electronAPI.usage.query(params)
  if (!res.success || !res.data) {
    throw new Error(res.error || '查询用量失败')
  }
  return res.data
}
