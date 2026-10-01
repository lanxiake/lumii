/**
 * 网络延迟探测服务 — 封装 window.electronAPI.net 的薄层
 */

import type { PingReport } from '../../shared/net-latency-types'

/** 低频延迟探测；返回国内/国外两组与自适应 best */
export async function pingNetwork(): Promise<PingReport> {
  return window.electronAPI.net.ping()
}
