/**
 * 维护体检报告服务 — 封装 window.electronAPI.maintenanceReport
 *
 * 差分在主进程算好一起返回（依赖 findings 的稳定 key 语义），渲染层只负责展示。
 */
import type { FindingDiff, MaintenanceReport } from '@main/maintenance-report-store'

export interface MaintenanceOverview {
  reports: MaintenanceReport[]
  diff: FindingDiff | null
}

/** 拉取最近几期报告 + 最新一期对上一期的差分；接口不可用或失败抛错 */
export async function fetchMaintenanceOverview(limit = 5): Promise<MaintenanceOverview> {
  const api = window.electronAPI?.maintenanceReport
  if (!api) throw new Error('体检报告接口不可用')
  const res = await api.overview(limit)
  if (!res) throw new Error('体检报告接口不可用')
  if (!res.success) throw new Error(res.error ?? '读取体检报告失败')
  return res.data ?? { reports: [], diff: null }
}
