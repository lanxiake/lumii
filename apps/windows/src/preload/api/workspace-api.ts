/**
 * 工作空间相关 API
 */
import { ipcRenderer } from 'electron'
import type {
  CleanupRestoreResult,
  CleanupRunResult,
  CleanupScanResponse,
  CleanupTrashEntry,
} from '../../shared/workspace-cleanup-types'

export const workspaceApi = {
  getDir: () => ipcRenderer.invoke('workspace:getDir'),
  setDir: (dirPath: string) => ipcRenderer.invoke('workspace:setDir', dirPath),
  notifyChanged: (newDirPath?: string) => ipcRenderer.invoke('workspace:notifyChanged', newDirPath),
  selectDir: (currentPath?: string) => ipcRenderer.invoke('workspace:selectDir', currentPath),
  ensureDir: (dirPath: string) => ipcRenderer.invoke('workspace:ensureDir', dirPath),

  /** 扫描工作区四类占用 + 可清理候选 */
  cleanupScan: (opts?: { budgetMs?: number }): Promise<CleanupScanResponse> =>
    ipcRenderer.invoke('workspace:cleanup:scan', opts),
  /** 执行清理；dryRun=true 只统计 */
  cleanupRun: (payload: {
    target: 'intermediate' | 'ephemeral' | 'both'
    dryRun: boolean
    /** 当前会话声明为成品的路径，清理时排除 */
    protectedPaths?: readonly string[]
  }): Promise<CleanupRunResult> => ipcRenderer.invoke('workspace:cleanup:run', payload),
  cleanupListTrash: (): Promise<CleanupTrashEntry[]> =>
    ipcRenderer.invoke('workspace:cleanup:listTrash'),
  cleanupRestore: (id: string): Promise<CleanupRestoreResult> =>
    ipcRenderer.invoke('workspace:cleanup:restore', id),
}
