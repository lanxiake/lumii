/**
 * 自主进化开关联动：关闭时暂停心跳与 agent-self 自建任务，开启时恢复未过期项。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../packages/agent-runtime/src/storage/schema'
import { createTestSqliteAdapter } from '../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import {
  SUSPENDED_AUTONOMOUS_JOBS_KEY,
  syncAutonomousManagedCronJobs,
} from './autonomous-cron-linkage'
import { ensureEvolutionCronJobSeeded } from './evolution-tick'

function createMigratedDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter()
  for (const [, sql] of MIGRATIONS) db.exec(sql)
  return db
}

const hasFts5Db = (() => {
  try {
    const db = createTestSqliteAdapter()
    db.close()
    return true
  } catch {
    return false
  }
})()

function insertJob(
  db: DatabaseAdapter,
  id: string,
  opts: { scheduleType?: 'at' | 'every' | 'cron'; nextRunAt?: number; enabled?: number } = {},
): void {
  db.prepare(
    `INSERT INTO local_cron_jobs
     (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets)
     VALUES (?, ?, '任务内容', 'assistant', ?, '', ?, 3600000, ?, 0, 'silent')`,
  ).run(id, id, opts.scheduleType ?? 'every', opts.nextRunAt ?? Date.now() + 3_600_000, opts.enabled ?? 1)
}

function isEnabled(db: DatabaseAdapter, id: string): boolean {
  const row = db.prepare<{ enabled: number }>(`SELECT enabled FROM local_cron_jobs WHERE id = ?`).get(id)
  return row?.enabled === 1
}

function readSuspended(db: DatabaseAdapter): string[] {
  const row = db
    .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
    .get(SUSPENDED_AUTONOMOUS_JOBS_KEY)
  return row ? (JSON.parse(row.value) as string[]) : []
}

describe.skipIf(!hasFts5Db)('自主进化开关联动定时任务', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
  })

  it('关闭开关：心跳与全部启用中的 agent-self 任务暂停，用户任务不受影响', () => {
    insertJob(db, 'agent-self:a')
    insertJob(db, 'agent-self:b')
    insertJob(db, 'user-job-uuid')
    insertJob(db, 'agent-self:already-off', { enabled: 0 })

    const result = syncAutonomousManagedCronJobs(db, false)

    expect(result.suspended.sort()).toEqual(['agent-self:a', 'agent-self:b'])
    expect(isEnabled(db, 'agent-self:a')).toBe(false)
    expect(isEnabled(db, 'agent-self:b')).toBe(false)
    expect(isEnabled(db, 'user-job-uuid')).toBe(true)
    expect(readSuspended(db).sort()).toEqual(['agent-self:a', 'agent-self:b'])
    // 心跳播种且跟随开关
    expect(isEnabled(db, 'autonomous-tick')).toBe(false)
  })

  it('重复关闭：挂起清单取并集，不丢失首轮记录', () => {
    insertJob(db, 'agent-self:a')
    syncAutonomousManagedCronJobs(db, false)
    insertJob(db, 'agent-self:late')

    syncAutonomousManagedCronJobs(db, false)

    expect(readSuspended(db).sort()).toEqual(['agent-self:a', 'agent-self:late'])
  })

  it('重新开启：恢复 every 与未过期 at；过期 at 不复活；已删除任务丢弃', () => {
    insertJob(db, 'agent-self:recurring')
    insertJob(db, 'agent-self:future-once', { scheduleType: 'at', nextRunAt: Date.now() + 3_600_000 })
    insertJob(db, 'agent-self:expired-once', { scheduleType: 'at', nextRunAt: Date.now() - 60_000 })
    insertJob(db, 'agent-self:deleted')
    syncAutonomousManagedCronJobs(db, false)
    db.prepare(`DELETE FROM local_cron_jobs WHERE id = ?`).run('agent-self:deleted')

    const result = syncAutonomousManagedCronJobs(db, true)

    expect(result.restored.sort()).toEqual(['agent-self:future-once', 'agent-self:recurring'])
    expect(isEnabled(db, 'agent-self:recurring')).toBe(true)
    expect(isEnabled(db, 'agent-self:future-once')).toBe(true)
    expect(isEnabled(db, 'agent-self:expired-once')).toBe(false)
    expect(isEnabled(db, 'autonomous-tick')).toBe(true)
    // 全部处理完，挂起清单清空
    expect(readSuspended(db)).toEqual([])
  })

  it('用户手动暂停的任务不在挂起清单，重开时不会被恢复', () => {
    insertJob(db, 'agent-self:a')
    syncAutonomousManagedCronJobs(db, false)
    // 模拟用户在定时任务页手动暂停另一个自建任务（清单外）
    insertJob(db, 'agent-self:manual-off', { enabled: 0 })

    syncAutonomousManagedCronJobs(db, true)

    expect(isEnabled(db, 'agent-self:a')).toBe(true)
    expect(isEnabled(db, 'agent-self:manual-off')).toBe(false)
  })

  it('ensureEvolutionCronJobSeeded：enabled 跟随开关，形态自愈仍然生效', () => {
    ensureEvolutionCronJobSeeded(db, true)
    expect(isEnabled(db, 'autonomous-tick')).toBe(true)
    // 模拟被误改成 agent 驱动
    db.prepare(`UPDATE local_cron_jobs SET agent_id = 'assistant', enabled = 0 WHERE id = 'autonomous-tick'`).run()

    ensureEvolutionCronJobSeeded(db, false)

    const row = db
      .prepare<{ agent_id: string | null; enabled: number; schedule_type: string }>(
        `SELECT agent_id, enabled, schedule_type FROM local_cron_jobs WHERE id = 'autonomous-tick'`,
      )
      .get()
    expect(row).toMatchObject({ agent_id: null, enabled: 0, schedule_type: 'every' })
  })
})
