/**
 * 播种幂等性测试。
 *
 * 不起真库：app 侧 vitest 没带 --experimental-sqlite，better-sqlite3 又按 Electron ABI 编译。
 * 这里用 Map 模拟 local_cron_jobs / runtime_state 两张表 —— 要验的是哨兵键分支，不是 SQL 执行。
 */

import { describe, expect, it } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { ensureSeedCronJobsSeeded, __testables } from './seed-cron-jobs'

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
        } else if (sql.includes('UPDATE local_cron_jobs') && sql.includes('system_prompt')) {
          // 迁移 system_prompt：只更新字段，不改变 jobs Map 结构
          const id = String(params[1])
          if (jobs.has(id)) {
            return { changes: 1, lastInsertRowid: 0 }
          }
        } else if (sql.includes('UPDATE local_cron_jobs') && sql.includes('agent_id')) {
          // 归属迁移：从 SQL 里取新 agent id。两种 WHERE 形态都要认——
          // 预置任务用字面量 id（无参数），按任务查出来的行用占位符。
          const nextAgent = /SET agent_id\s*=\s*'([^']+)'/.exec(sql)?.[1]
          const literalId = /WHERE id = '([^']+)'/.exec(sql)?.[1]
          const id = params.length > 0 ? String(params[0]) : (literalId ?? '')
          const row = jobs.get(id)
          const onlyDefaultAgent = sql.includes("agent_id = 'assistant'")
          if (row && nextAgent && (!onlyDefaultAgent || row[COL.agentId] === 'assistant')) {
            row[COL.agentId] = nextAgent
            return { changes: 1, lastInsertRowid: 0 }
          }
          return { changes: 0, lastInsertRowid: 0 }
        } else if (sql.includes('INSERT OR REPLACE INTO runtime_state')) {
          state.set(String(params[0]), String(params[1] ?? '1'))
        } else if (sql.includes('DELETE FROM local_cron_jobs')) {
          const deleted = jobs.delete(String(params[0]))
          return { changes: deleted ? 1 : 0, lastInsertRowid: 0 }
        }
        return { changes: 1, lastInsertRowid: 0 }
      },
      get: (...params: unknown[]) => {
        if (sql.includes('FROM local_cron_jobs')) {
          const row = jobs.get(String(params[0]))
          if (sql.includes('system_prompt')) {
            // 迁移查询：返回 system_prompt 字段
            return row ? { system_prompt: null } : undefined
          }
          return row ? { id: params[0] } : undefined
        }
        if (sql.includes('FROM runtime_state')) {
          const value = state.get(String(params[0]))
          return value === undefined ? undefined : { value }
        }
        return undefined
      },
      all: (..._params: unknown[]) => {
        // 资讯管线迁移：按「任务指令里带 dashboard_feed_write 且仍挂在默认 Agent」筛行
        if (sql.includes('FROM local_cron_jobs') && sql.includes('dashboard_feed_write')) {
          return [...jobs.values()]
            .filter((row) => row[COL.agentId] === 'assistant')
            .filter((row) => String(row[COL.taskText] ?? '').includes('dashboard_feed_write'))
            .map((row) => ({ id: row[COL.id], name: row[COL.name] }))
        }
        return []
      },
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

  it('资讯任务挂 info-curator、静默通知（Agent 直接写卡片），任务指令为自然语言', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    const row = db.jobs.get('news-pipeline')!
    expect(row[COL.agentId]).toBe('info-curator')
    // silent：Agent 通过 dashboard_feed_write 直接写卡片，派发器不再重复塞入原始回复
    expect(row[COL.notifyTargets]).toBe('silent')
    expect(row[COL.taskText]).not.toContain('__lumii_workflow__')
    expect(String(row[COL.taskText])).toContain('dashboard_feed_write')
  })

  it('简报类预置任务挂到 chronicler（团队转正）', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    const row = db.jobs.get('seed-morning-briefing')!
    expect(row[COL.agentId]).toBe('chronicler')
  })

  it('SEED_JOBS 定义：简报类挂 chronicler，资讯任务挂 info-curator', () => {
    for (const id of ['seed-morning-briefing', 'seed-daily-report', 'seed-weekly-review', 'seed-focus-check'] as const) {
      expect(__testables.SEED_JOBS.find((j) => j.id === id)?.agentId, id).toBe('chronicler')
    }
    expect(__testables.SEED_JOBS.find((j) => j.id === 'news-pipeline')?.agentId).toBe('info-curator')
  })

  it('工作区体检挂到 system-keeper（维护的活归维护）', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    expect(db.jobs.get('seed-workspace-tidy')![COL.agentId]).toBe('system-keeper')
    expect(__testables.SEED_JOBS.find((j) => j.id === 'seed-workspace-tidy')?.agentId).toBe('system-keeper')
  })

  it('老库升级：工作区体检从 assistant 迁到 system-keeper', () => {
    const db = createFakeDb()
    // 模拟老库：已按旧定义种下、执行者仍是 assistant
    db.jobs.set('seed-workspace-tidy', [
      'seed-workspace-tidy',
      '工作区文件整理',
      '检查工作区里新增的文件',
      'assistant',
      'cron',
      '0 20 * * 0',
      0,
      null,
      1,
      0,
      null,
      null,
      null,
      null,
      'system',
    ])
    ensureSeedCronJobsSeeded(db.adapter)
    expect(db.jobs.get('seed-workspace-tidy')![COL.agentId]).toBe('system-keeper')
  })

  it('用户改过执行者的任务不被归属迁移覆盖', () => {
    const db = createFakeDb()
    db.jobs.set('seed-workspace-tidy', [
      'seed-workspace-tidy',
      '工作区文件整理',
      '检查工作区里新增的文件',
      'code-dev',
      'cron',
      '0 20 * * 0',
      0,
      null,
      1,
      0,
      null,
      null,
      null,
      null,
      'system',
    ])
    ensureSeedCronJobsSeeded(db.adapter)
    expect(db.jobs.get('seed-workspace-tidy')![COL.agentId]).toBe('code-dev')
  })

  it('用户自建的资讯任务也迁到 info-curator（按指令里的 dashboard_feed_write 认领）', () => {
    const db = createFakeDb()
    db.jobs.set('local-cron-1-abc', [
      'local-cron-1-abc',
      '资讯抓取与综述',
      '搜索今天值得关注的热门资讯，调用 dashboard_feed_write 写入概览页资讯卡片。',
      'assistant',
      'cron',
      '0 8 * * *',
      0,
      null,
      1,
      0,
      null,
      null,
      null,
      null,
      'news,feishu',
    ])
    db.jobs.set('local-cron-2-def', [
      'local-cron-2-def',
      '随手记一句',
      '把这句话记下来。',
      'assistant',
      'cron',
      '0 9 * * *',
      0,
      null,
      1,
      0,
      null,
      null,
      null,
      null,
      'system',
    ])
    ensureSeedCronJobsSeeded(db.adapter)
    expect(db.jobs.get('local-cron-1-abc')![COL.agentId]).toBe('info-curator')
    // 与资讯无关的任务不受影响
    expect(db.jobs.get('local-cron-2-def')![COL.agentId]).toBe('assistant')
  })

  it('资讯任务 system_prompt 已升级：先读偏好 + 记录筛选依据', () => {
    const job = __testables.SEED_JOBS.find((j) => j.id === 'news-pipeline')
    expect(job?.systemPrompt).toContain('先读用户偏好')
    expect(job?.systemPrompt).toContain('筛选依据')
  })

  it('除专注提醒外，其余预置任务默认开启', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    for (const [id, row] of db.jobs) {
      expect(row[COL.enabled], id).toBe(1)
    }
  })

  it('综述与 Wiki ERO 抽取定时任务均已移除', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    expect(db.jobs.get('wiki-auto-synthesis')).toBeUndefined()
    expect(db.jobs.get('wiki-ero-extract')).toBeUndefined()
  })

  it('升级后自动清理老库里的 Wiki 分类综述定时任务', () => {
    const db = createFakeDb()
    db.jobs.set('wiki-auto-synthesis', ['wiki-auto-synthesis', 'Wiki 分类综述自动刷新'])
    ensureSeedCronJobsSeeded(db.adapter)
    expect(db.jobs.get('wiki-auto-synthesis')).toBeUndefined()
  })

  it('四类产出任务仍会种入（资讯/简报/日报/复盘）', () => {
    const db = createFakeDb()
    ensureSeedCronJobsSeeded(db.adapter)
    expect(db.jobs.has('news-pipeline')).toBe(true)
    expect(db.jobs.has('seed-morning-briefing')).toBe(true)
    expect(db.jobs.has('seed-daily-report')).toBe(true)
    expect(db.jobs.has('seed-weekly-review')).toBe(true)
  })

  it('工作日报与周复盘改用工作记忆，不引用不存在的 conversation_history_read', () => {
    const daily = __testables.SEED_JOBS.find((j) => j.id === 'seed-daily-report')
    const weekly = __testables.SEED_JOBS.find((j) => j.id === 'seed-weekly-review')
    expect(daily?.systemPrompt).not.toContain('conversation_history_read')
    expect(daily?.systemPrompt).toContain('工作记忆')
    expect(daily?.systemPrompt).toContain('memory_manage')
    expect(weekly?.systemPrompt).not.toContain('conversation_history_read')
    expect(weekly?.systemPrompt).toContain('memory_manage')
  })

  it('简报/日报/复盘不再通过 focus 写入工作记忆', () => {
    for (const id of ['seed-morning-briefing', 'seed-daily-report', 'seed-weekly-review'] as const) {
      const job = __testables.SEED_JOBS.find((j) => j.id === id)
      expect(job?.notifyTargets, id).toBe('system')
      expect(job?.notifyTargets, id).not.toContain('focus')
    }
  })
})
