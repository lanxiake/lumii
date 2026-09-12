/**
 * 云同步服务 — 封装 window.electronAPI.cloudSync 的薄层
 *
 * 读取类接口失败 / 无数据返回 null（原调用点均为「静默跳过」）；
 * 动作类接口原样返回 {success, error} 结果，由调用方负责提示。
 */
import type { CloudSyncConfigView, SyncStatus } from '@main/cloud-sync/types'
import type { SyncLogEntry } from '@main/cloud-sync/sync-log'

export interface CloudSyncActionResult {
  success: boolean
  error?: string
}

export interface CloudSyncSaveResult {
  success: boolean
  data?: CloudSyncConfigView
  error?: string
}

/** 读取云同步配置；失败或无数据返回 null */
export async function fetchCloudSyncConfig(): Promise<CloudSyncConfigView | null> {
  const r = await window.electronAPI.cloudSync.getConfig()
  return r.success && r.data ? r.data : null
}

/** 读取同步状态；失败或无数据返回 null */
export async function fetchCloudSyncStatus(): Promise<SyncStatus | null> {
  const r = await window.electronAPI.cloudSync.getStatus()
  return r.success && r.data ? r.data : null
}

/** 读取同步日志；失败或无数据返回 null */
export async function fetchCloudSyncLogs(): Promise<SyncLogEntry[] | null> {
  const r = await window.electronAPI.cloudSync.getLogs()
  return r.success && r.data ? r.data : null
}

/** 保存配置（token 留空表示沿用已保存令牌）；结果原样返回 */
export async function saveCloudSyncConfig(view: CloudSyncConfigView): Promise<CloudSyncSaveResult> {
  return window.electronAPI.cloudSync.setConfig(view)
}

/** 测试仓库连通性；结果原样返回 */
export async function testCloudSyncConnection(view: CloudSyncConfigView): Promise<CloudSyncActionResult> {
  return window.electronAPI.cloudSync.testConnection(view)
}

/** 立即触发一次同步（调用方只关心完成时机） */
export async function syncCloudSyncNow(): Promise<void> {
  await window.electronAPI.cloudSync.syncNow()
}

/** 手动触发 Agent 重新处理冲突；结果原样返回 */
export async function retryCloudSyncConflict(): Promise<CloudSyncActionResult> {
  return window.electronAPI.cloudSync.retryConflict()
}

/** 订阅主进程状态广播，返回取消订阅函数 */
export function subscribeCloudSyncStatus(handler: (status: SyncStatus) => void): () => void {
  return window.electronAPI.cloudSync.onStatusChange(handler)
}
