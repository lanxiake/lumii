/**
 * CloudSyncManager 单例访问器。
 * 与 screen-record/accessor.ts 同模式：main/index.ts 启动时 set，IPC / 工具层 get。
 *
 * 状态挂在 `globalThis`（按 Symbol 取）：云同步正在从内置扩展迁成官方外部扩展，
 * 外部 bundle 会各自打一份本模块；模块级变量会变成两份互不相干的单例，
 * 表现为「扩展提供了 manager，但工具层 get 到 null」。用全局槽位后，
 * 两份代码读写的是同一个引用。主进程内置路径行为不变。
 */
import type { CloudSyncManager } from './sync-manager'

interface SharedAccessor {
  manager: CloudSyncManager | null
  onWorkspaceChanged: (() => void) | null
}

const SHARED_KEY = Symbol.for('lumii.cloud-sync.accessor')
const shared: SharedAccessor = ((globalThis as Record<symbol, unknown>)[SHARED_KEY] ??= {
  manager: null,
  onWorkspaceChanged: null,
}) as SharedAccessor

/** 传 null 表示扩展已卸载：IPC/工具层不应再读到旧实例 */
export function setCloudSyncManager(m: CloudSyncManager | null): void {
  shared.manager = m
}

export function getCloudSyncManager(): CloudSyncManager | null {
  return shared.manager
}

/** Turn 快照后触发同步防抖（由 main/index.ts 注入 scheduler.onWorkspaceChanged） */
export function setCloudSyncWorkspaceChangedHandler(fn: (() => void) | null): void {
  shared.onWorkspaceChanged = fn
}

export function notifyCloudSyncWorkspaceChanged(): void {
  shared.onWorkspaceChanged?.()
}
