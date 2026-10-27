/**
 * 自动清理设置的读取入口。
 *
 * 设置存在 `AppConfig.storageCleanup`；但清理的触发点（cron / companion / 启动补跑）
 * 不在 IPC 层，拿不到 ConfigManager——所以启动时由注册处注入一个只读 getter，
 * 调用点统一走这里，避免每个触发点各自去摸配置。
 */

import {
  DEFAULT_STORAGE_CLEANUP_PREFS,
  normalizeStorageCleanupPrefs,
  type StorageCleanupPrefs,
} from './workspace-cleanup-runner'

let provider: (() => unknown) | null = null

export function setStorageCleanupPrefsProvider(next: (() => unknown) | null): void {
  provider = next
}

export function getStorageCleanupPrefs(): StorageCleanupPrefs {
  if (!provider) return DEFAULT_STORAGE_CLEANUP_PREFS
  try {
    return normalizeStorageCleanupPrefs(provider())
  } catch {
    return DEFAULT_STORAGE_CLEANUP_PREFS
  }
}
