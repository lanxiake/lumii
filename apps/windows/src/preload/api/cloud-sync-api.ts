/**
 * 云同步 Preload API（设置页 + Agent 冲突解决只读通道）。
 */
import { ipcRenderer } from 'electron'
import type { CloudSyncConfigView, SyncState, SyncStatus } from '../../main/cloud-sync/types'
import type { SyncLogEntry } from '../../main/cloud-sync/sync-log'

export type ResolveStrategy = 'keep-local' | 'keep-remote' | 'per-file'
export type ResolveChoice = { path: string; side: 'local' | 'remote' }

export const cloudSyncApi = {
  getConfig: (): Promise<{ success: boolean; data?: CloudSyncConfigView; error?: string }> =>
    ipcRenderer.invoke('cloudSync:getConfig'),
  setConfig: (view: CloudSyncConfigView): Promise<{ success: boolean; data?: CloudSyncConfigView; error?: string }> =>
    ipcRenderer.invoke('cloudSync:setConfig', view),
  testConnection: (view: CloudSyncConfigView): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('cloudSync:testConnection', view),
  getStatus: (): Promise<{ success: boolean; data?: SyncStatus }> =>
    ipcRenderer.invoke('cloudSync:getStatus'),
  getLogs: (): Promise<{ success: boolean; data?: SyncLogEntry[] }> =>
    ipcRenderer.invoke('cloudSync:getLogs'),
  syncNow: (): Promise<{ success: boolean; state: SyncState }> =>
    ipcRenderer.invoke('cloudSync:syncNow'),
  resolveConflict: (
    strategy: ResolveStrategy,
    choices?: ResolveChoice[],
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('cloudSync:resolveConflict', strategy, choices),
  readFileAt: (
    oid: 'local' | 'remote' | 'base',
    filepath: string,
  ): Promise<{ success: boolean; data?: string | null }> =>
    ipcRenderer.invoke('cloudSync:readFileAt', oid, filepath),
  /** 手动触发 Agent 重新处理云同步冲突（设置页「重试处理」按钮） */
  retryConflict: (): Promise<{ success: boolean; result?: string; error?: string }> =>
    ipcRenderer.invoke('cloudSync:retryConflict'),
  /** 待用户确认的批量删除（删除安全阀挡下时非空；确认需原样回传 fingerprint） */
  getPendingMassDelete: (): Promise<{
    success: boolean
    data?: { fingerprint: string; count: number; createdAt: number } | null
  }> => ipcRenderer.invoke('cloudSync:getPendingMassDelete'),
  /**
   * 用户显式确认批量删除（设置页「确认删除」按钮）。
   * 必须回传 getPendingMassDelete 给出的指纹 —— 集合变化时确认会被拒绝。
   */
  confirmMassDelete: (fingerprint: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('cloudSync:confirmMassDelete', fingerprint),
  /** 阶段二（大文件队列）进度快照；队列未启动过时 data 为 null */
  getLargeQueueStats: (): Promise<{
    success: boolean
    data?: { pendingFiles: number; pendingBytes: number; pumping: boolean; at: number } | null
  }> => ipcRenderer.invoke('cloudSync:getLargeQueueStats'),
  onStatusChange: (callback: (status: SyncStatus) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: SyncStatus) => callback(status)
    ipcRenderer.on('cloudSync:status', handler)
    return () => ipcRenderer.removeListener('cloudSync:status', handler)
  },
}
