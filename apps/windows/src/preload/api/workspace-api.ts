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
import type {
  DedupeApplyResult,
  DedupeFailure,
  DedupePlanResult,
} from '../../shared/workspace-dedupe-types'

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
  /** 自动清理策略 */
  cleanupGetPrefs: (): Promise<import('../../main/workspace-cleanup-runner').StorageCleanupPrefs> =>
    ipcRenderer.invoke('workspace:cleanup:getPrefs'),
  cleanupSetPrefs: (prefs: unknown): Promise<{
    ok: boolean
    prefs: import('../../main/workspace-cleanup-runner').StorageCleanupPrefs
  }> => ipcRenderer.invoke('workspace:cleanup:setPrefs', prefs),
  /** 立即清理（不等空闲） */
  cleanupRunNow: (): Promise<import('../../main/workspace-cleanup-runner').ScheduledCleanupResult> =>
    ipcRenderer.invoke('workspace:cleanup:runNow'),
  /** 扫描可去重的中间产物（只读，手动触发） */
  dedupePlan: (opts?: { budgetMs?: number }): Promise<DedupePlanResult | DedupeFailure> =>
    ipcRenderer.invoke('workspace:cleanup:dedupePlan', opts),
  /** 执行去重（硬链接；服务端重新算一次计划） */
  dedupeApply: (): Promise<DedupeApplyResult | DedupeFailure> =>
    ipcRenderer.invoke('workspace:cleanup:dedupeApply'),
  /** 最近清理记录 */
  cleanupHistory: (
    limit?: number,
  ): Promise<import('../../main/workspace-cleanup-history').CleanupHistoryEntry[]> =>
    ipcRenderer.invoke('workspace:cleanup:history', limit),
}
