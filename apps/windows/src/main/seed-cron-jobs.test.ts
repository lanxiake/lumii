/**
 * 播种幂等性测试。
 *
 * 不起真库：app 侧 vitest 没带 --experimental-sqlite，better-sqlite3 又按 Electron ABI 编译。
 * 这里用 Map 模拟 local_cron_jobs / runtime_state 两张表 —— 要验的是哨兵键分支，不是 SQL 执行。
 */

import { describe, expect, it } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { ensureSeedCronJobsSeeded } from './seed-cron-jobs'

interface FakeDb {
  adapter: DatabaseAdapter
  jobs: Map<string, unknown[]>
  state: Map<string, string>
}

function createFakeDb(): FakeDb {
  const jobs = new Map<string, unknown[]>()
  const state = new Map<string, string>()

  const adapter = {
    exec: () => undefined,
    close: () => undefined,
    prepare: (sql: string) => ({
      run: (...params: unknown[]) => {
        if (sql.includes('INSERT INTO local_cron_jobs')) {
          jobs.set(String(params[0]), params)
        } else if (sql.includes('INSERT OR REPLACE INTO runtime_state')) {
          state.set(String(params[0]), String(params[1] ?? '1'))
        }
        return { changes: 1, lastInsertRowid: 0 }
      },
      get: (...params: unknown[]) => {
        if (sql.includes('FROM local_cron_jobs')) {
          const row = jobs.get(String(params[0]))
          return row ? { id: params[0] } : undefined
        }
        if (sql.includes('FROM runtime_state')) {
          const value = state.get(String(params[0]))
          return value === undefined ? undefined : { value }
        }
        return undefined
      },
      all: () => [],
    }),
  } as unknown as DatabaseAdapter

  return { adapter, jobs, state }
}

/** INSERT 的列顺序，用于从记录的参数数组里取字段 */
const COL = {
  id: 0,
  name: 1,
  taskText: 2,
  agentId: 3,
  scheduleType: 4,
  scheduleExpr: 5,
  enabled: 8,
  notifyTargets: 14,
} as const

describe('ensureSeedCronJobsSeeded', () => {
  it('首启种入全部预置任务', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    expect(db.jobs.size).toBeGreaterThan(1)
    expect(db.jobs.has('news-pipeline')).toBe(true)
    expect(db.jobs.has('seed-morning-briefing')).toBe(true)
  })

  it('重复调用不会重复种（幂等）', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    const first = db.jobs.size
    ensureSeedCronJobsSeeded(db.adapter)
    expect(db.jobs.size).toBe(first)
  })

  it('用户删掉任务后不再种回（哨兵键生效）', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    // 模拟用户删除：只删任务记录，哨兵键留着
    db.jobs.delete('seed-morning-briefing')
    ensureSeedCronJobsSeeded(db.adapter)
    expect(db.jobs.has('seed-morning-briefing')).toBe(false)
  })

  it('老版本删过资讯任务时，旧哨兵键阻止复活', () => {
    const db = createFakeDb()
    db.state.set('workflow:news:seeded', '1')
    ensureSeedCronJobsSeeded(db.adapter)
    expect(db.jobs.has('news-pipeline')).toBe(false)
    // 其他任务不受影响
    expect(db.jobs.has('seed-morning-briefing')).toBe(true)
  })

  it('资讯任务挂 assistant、静默通知（Agent 直接写卡片），任务指令为自然语言', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    const row = db.jobs.get('news-pipeline')!
    expect(row[COL.agentId]).toBe('assistant')
    // silent：Agent 通过 dashboard_feed_write 直接写卡片，派发器不再重复塞入原始回复
    expect(row[COL.notifyTargets]).toBe('silent')
    expect(row[COL.taskText]).not.toContain('__lumii_workflow__')
    expect(String(row[COL.taskText])).toContain('dashboard_feed_write')
  })

  it('Agent 类预置任务挂到 assistant', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    const row = db.jobs.get('seed-morning-briefing')!
    expect(row[COL.agentId]).toBe('assistant')
  })

  it('除专注提醒外，其余预置任务默认开启', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    for (const [id, row] of db.jobs) {
      expect(row[COL.enabled], id).toBe(1)
    }
  })
})
