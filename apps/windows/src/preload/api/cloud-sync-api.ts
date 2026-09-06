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
  onStatusChange: (callback: (status: SyncStatus) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: SyncStatus) => callback(status)
    ipcRenderer.on('cloudSync:status', handler)
    return () => ipcRenderer.removeListener('cloudSync:status', handler)
  },
}
