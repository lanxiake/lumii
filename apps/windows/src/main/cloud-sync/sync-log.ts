/**
 * 云同步历史日志（最多 100 条，环形缓冲持久化）。
 *
 * 独立文件 ~/.lumii/config/cloud-sync-log.json，每次状态变更追加一条，
 * 超出 100 条丢弃最旧。供设置页「同步日志」区块回看历史与异常。
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import { createLogger } from '../logger'
import type { SyncState } from './types'

const logger = createLogger('cloud-sync/log')

export const MAX_SYNC_LOGS = 100

export interface SyncLogEntry {
  /** 时间戳（ms） */
  ts: number
  state: SyncState
  message: string
}

const logFile = (): string =>
  path.join(resolveWindowsClientDataRoot(), 'config', 'cloud-sync-log.json')

function isValidEntry(e: unknown): e is SyncLogEntry {
  return typeof (e as SyncLogEntry)?.ts === 'number' && typeof (e as SyncLogEntry)?.message === 'string'
}

/** 读取历史日志（旧→新，最多 100 条） */
export function loadSyncLogs(): SyncLogEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(logFile(), 'utf-8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(isValidEntry).slice(-MAX_SYNC_LOGS)
  } catch {
    return []
  }
}

/** 追加一条日志并落盘，返回截断后的全量（旧→新） */
export function appendSyncLog(state: SyncState, message: string): SyncLogEntry[] {
  const next = [...loadSyncLogs(), { ts: Date.now(), state, message }].slice(-MAX_SYNC_LOGS)
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true })
    fs.writeFileSync(logFile(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    logger.warn(`[appendSyncLog] 写入同步日志失败: ${(err as Error).message}`)
  }
  return next
}
