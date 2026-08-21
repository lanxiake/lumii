/**
 * Storage (存储) 命令处理器
 *
 * 提取自 agent-runtime-ipc.ts
 */

import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'

const log = {
  error: (...args: unknown[]) => console.error('[AgentRuntime:IPC]', ...args),
}

// ============================================================
// 命令处理器
// ============================================================

export function handleStorageStats(bridge: AgentRuntimeBridge): unknown {
  return bridge.getLocalStorageStats()
}

export function handleStorageExportJsonl(bridge: AgentRuntimeBridge): unknown {
  return bridge.exportLocalDataJSONL()
}

export function handleStorageClearMalformed(bridge: AgentRuntimeBridge): unknown {
  return bridge.clearMalformedMessages()
}

export function handleStorageListBackups(bridge: AgentRuntimeBridge): unknown {
  return bridge.listDatabaseBackups()
}

export function handleStorageCreateBackup(
  bridge: AgentRuntimeBridge,
): { ok: boolean; error?: string } {
  try {
    const backup = bridge.createDatabaseBackupNow()
    return { ok: true, ...backup }
  } catch (err) {
    log.error('[storage:createBackup] failed:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function handleStorageRestoreBackup(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'storage:restoreBackup' }>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    return {
      ok: true,
      ...(await bridge.restoreDatabaseFromBackupFile(String(command.backupFileName ?? ''))),
    }
  } catch (err) {
    log.error('[storage:restoreBackup] failed:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function handleStorageRestoreLatestBackup(
  bridge: AgentRuntimeBridge,
): Promise<{ ok: boolean; error?: string }> {
  try {
    return { ok: true, ...(await bridge.restoreDatabaseFromLatestBackup()) }
  } catch (err) {
    log.error('[storage:restoreLatestBackup] failed:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function handleStorageDeleteBackup(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'storage:deleteBackup' }>,
): { ok: boolean; error?: string } {
  try {
    bridge.deleteDatabaseBackupFile(String(command.backupFileName ?? ''))
    return { ok: true }
  } catch (err) {
    log.error('[storage:deleteBackup] failed:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function handleStorageAuditRecent(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'storage:auditRecent' }>,
): unknown {
  return bridge.auditRepo.listRecentGlobally(command.limit ?? 20)
}
