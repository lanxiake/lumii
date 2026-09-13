/**
 * 自主进化总开关（runtime_state: autonomous.enabled）与定时任务的联动。
 *
 * 关闭开关 → 暂停 autonomous-tick 与全部 agent-self:* 自建任务，
 * 被暂停的 id 记入挂起清单；重新开启 → 恢复清单中仍存在且未过期的任务
 * （一次性任务错过了执行时刻就不再复活）。
 *
 * 与 companion-tick 跟随「主动联系」开关（local-companion-handler.ts）同一模式：
 * 开关是这类任务的唯一控制源，启动与每次开关切换都会重放一次本同步。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { SELF_CRON_ID_PREFIX } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'
import { ensureEvolutionCronJobSeeded } from './evolution-tick'

export const SUSPENDED_AUTONOMOUS_JOBS_KEY = 'autonomous.suspendedCronJobs'

export interface AutonomousCronLinkageResult {
  suspended: string[]
  restored: string[]
}

function readSuspendedIds(db: DatabaseAdapter): string[] {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(SUSPENDED_AUTONOMOUS_JOBS_KEY)
    if (!row) return []
    const parsed = JSON.parse(row.value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeSuspendedIds(db: DatabaseAdapter, ids: string[]): void {
  if (ids.length === 0) {
    db.prepare(`DELETE FROM runtime_state WHERE key = ?`).run(SUSPENDED_AUTONOMOUS_JOBS_KEY)
    return
  }
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SUSPENDED_AUTONOMOUS_JOBS_KEY, JSON.stringify(ids), new Date().toISOString())
}

/** 暂停全部启用中的 Agent 自建任务，返回本次暂停的 id（并入挂起清单，供重开时恢复） */
export function suspendAutonomousAgentSelfJobs(db: DatabaseAdapter): string[] {
  const rows = db
    .prepare<{ id: string }>(`SELECT id FROM local_cron_jobs WHERE id LIKE ? AND enabled = 1`)
    .all(`${SELF_CRON_ID_PREFIX}%`)
  if (rows.length === 0) return []

  const update = db.prepare(`UPDATE local_cron_jobs SET enabled = 0 WHERE id = ?`)
  const ids = rows.map((r) => r.id)
  for (const id of ids) update.run(id)

  const merged = Array.from(new Set([...readSuspendedIds(db), ...ids]))
  writeSuspendedIds(db, merged)
  log.info(`[suspendAutonomousAgentSelfJobs] 已暂停 ${ids.length} 个 Agent 自建定时任务`)
  return ids
}

/** 恢复挂起清单中仍可运行的任务；已删除或已过期的一次性任务丢弃（不复活） */
export function restoreSuspendedAutonomousJobs(db: DatabaseAdapter): {
  restored: string[]
  skippedExpired: string[]
} {
  const ids = readSuspendedIds(db)
  if (ids.length === 0) return { restored: [], skippedExpired: [] }

  const now = Date.now()
  const restored: string[] = []
  const skippedExpired: string[] = []
  for (const id of ids) {
    const row = db
      .prepare<{ schedule_type: string; next_run_at: number }>(
        `SELECT schedule_type, next_run_at FROM local_cron_jobs WHERE id = ?`,
      )
      .get(id)
    if (!row) continue
    if (row.schedule_type === 'at' && row.next_run_at <= now) {
      skippedExpired.push(id)
      continue
    }
    db.prepare(`UPDATE local_cron_jobs SET enabled = 1 WHERE id = ?`).run(id)
    restored.push(id)
  }
  writeSuspendedIds(db, [])
  log.info(
    `[restoreSuspendedAutonomousJobs] 恢复 ${restored.length} 个 Agent 自建定时任务` +
      (skippedExpired.length > 0 ? `，${skippedExpired.length} 个已过期不复活` : ''),
  )
  return { restored, skippedExpired }
}

/**
 * 同步自主进化托管的任务状态（幂等，绝不抛）：
 * 心跳 enabled 跟随开关；开关关闭时暂停自建任务，开启时恢复。
 */
export function syncAutonomousManagedCronJobs(
  db: DatabaseAdapter,
  enabled: boolean,
): AutonomousCronLinkageResult {
  const result: AutonomousCronLinkageResult = { suspended: [], restored: [] }
  try {
    ensureEvolutionCronJobSeeded(db, enabled)
    if (enabled) {
      result.restored = restoreSuspendedAutonomousJobs(db).restored
    } else {
      result.suspended = suspendAutonomousAgentSelfJobs(db)
    }
  } catch (err) {
    log.warn('[syncAutonomousManagedCronJobs] 同步失败:', err instanceof Error ? err.message : err)
  }
  return result
}
