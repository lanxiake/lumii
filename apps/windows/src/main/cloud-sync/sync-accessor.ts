/**
 * CloudSyncManager 单例访问器。
 * 与 screen-record/accessor.ts 同模式：main/index.ts 启动时 set，IPC / 工具层 get。
 */
import type { CloudSyncManager } from './sync-manager'

let manager: CloudSyncManager | null = null

export function setCloudSyncManager(m: CloudSyncManager): void {
  manager = m
}

export function getCloudSyncManager(): CloudSyncManager | null {
  return manager
}

/** Turn 快照后触发同步防抖（由 main/index.ts 注入 scheduler.onWorkspaceChanged） */
let onWorkspaceChanged: (() => void) | null = null

export function setCloudSyncWorkspaceChangedHandler(fn: (() => void) | null): void {
  onWorkspaceChanged = fn
}

export function notifyCloudSyncWorkspaceChanged(): void {
  onWorkspaceChanged?.()
}
