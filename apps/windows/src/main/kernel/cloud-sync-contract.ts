/**
 * 云同步扩展的主进程契约与访问器。
 *
 * 核心（Agent 桥 / 控制口 / 工具层 / 启动阶段）只认这里的接口；
 * 实现在官方扩展 `plugins/external-src/cloud-sync/impl`，由扩展在 `apply` 里装配后挂上来。
 * 扩展没装/被禁用时取到 null，调用方按「云同步未初始化」处理。
 *
 * 状态挂 `globalThis`：官方扩展是独立 bundle，模块级变量会有第二份拷贝，
 * 否则工具层拿到的永远是 null（静默失能）。
 */
import type {
  CloudSyncConfig,
  ConflictInfo,
  LargeQueueStats,
  SyncState,
  SyncStatus,
} from '../../shared/cloud-sync'

/** 云同步管理器对核心开放的能力（其余方法属于插件内部实现细节） */
export interface CloudSyncManagerLike {
  getStatus(): SyncStatus
  getConflict(): ConflictInfo | undefined
  /** 上一轮落决是否仍在后台跑（不可取消，重复驱动只会堆积） */
  isResolveInFlight(): boolean
  markConflictProcessing(): void
  resolveConflict(
    strategy: 'keep-local' | 'keep-remote' | 'per-file',
    choices?: { path: string; side: 'local' | 'remote' }[],
  ): Promise<{ success: boolean; error?: string; stillRunning?: boolean }>
  sync(): Promise<{ success: boolean; state: SyncState }>
  readFileAt(side: 'local' | 'remote' | 'base', filepath: string): Promise<string | null>
  getPendingMassDelete(): { fingerprint: string; count: number; createdAt: number } | undefined
  confirmMassDelete(fingerprint: string): { success: boolean; error?: string }
  getLargeQueueStats(): LargeQueueStats | undefined
  /** Agent 冲突处理失败时把原因写进状态（供心跳重试判断） */
  recordConflictResolutionFailure(reason: string): void
  /** 工作区队列深度（云同步与 VCS 快照共用一条队列） */
  getQueueDepth(): number
  /** 大文件队列推送（本地文件 → 远端） */
  pushPaths(paths: readonly string[]): Promise<{ success: boolean; message: string }>
  /** 工具层诊断：本地/远端仓库状态 */
  gitStatus(): Promise<Record<string, unknown>>
  gitLog(limit?: number): Promise<Record<string, unknown>>
  gitRemote(): Promise<Record<string, unknown>>
}

/** 调度器对核心开放的能力 */
export interface SyncSchedulerLike {
  /** 缺省配置时由实现自己读已保存配置（核心不再依赖 sync-config） */
  start(cfg?: Pick<CloudSyncConfig, 'enabled' | 'intervalMinutes'>): void
  stop(): void
  /** 注入「冲突仍未解决」时的 Agent 驱动回调（S8 阶段接线） */
  setOnConflictPending(handler: () => Promise<void>): void
}

interface SharedAccessor {
  manager: CloudSyncManagerLike | null
  onWorkspaceChanged: (() => void) | null
}

const SHARED_KEY = Symbol.for('lumii.cloud-sync.accessor')
const shared: SharedAccessor = ((globalThis as Record<symbol, unknown>)[SHARED_KEY] ??= {
  manager: null,
  onWorkspaceChanged: null,
}) as SharedAccessor

/** 传 null 表示扩展已卸载：IPC/工具层不应再读到旧实例 */
export function setCloudSyncManager(m: CloudSyncManagerLike | null): void {
  shared.manager = m
}

export function getCloudSyncManager(): CloudSyncManagerLike | null {
  return shared.manager
}

/** Turn 快照后触发同步防抖（由扩展注入 scheduler.onWorkspaceChanged） */
export function setCloudSyncWorkspaceChangedHandler(fn: (() => void) | null): void {
  shared.onWorkspaceChanged = fn
}

export function notifyCloudSyncWorkspaceChanged(): void {
  shared.onWorkspaceChanged?.()
}
