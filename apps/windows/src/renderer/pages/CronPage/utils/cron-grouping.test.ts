import { describe, expect, it } from 'vitest'
import { groupCronJobs } from './cron-grouping'
import type { CronJob, CronJobSource } from '../../../hooks/business/useCron/types'

let seq = 0
function job(source: CronJobSource, patch: Partial<CronJob> = {}): CronJob {
  seq += 1
  return {
    id: `${source}-${seq}`,
    userId: '',
    agentId: 'assistant',
    name: `任务 ${seq}`,
    enabled: true,
    scheduleType: 'cron',
    scheduleExpr: '0 9 * * *',
    taskText: '做点事',
    status: 'idle',
    consecutiveErrors: 0,
    createdAt: new Date(2026, 0, 1).toISOString(),
    updatedAt: new Date(2026, 0, 1).toISOString(),
    source,
    ...patch,
  }
}

describe('groupCronJobs', () => {
  it('组序固定：我的任务 → 系统任务 → Agent 自建，空组不出现', () => {
    const groups = groupCronJobs([
      job('agent'),
      job('system'),
      job('user'),
    ])
    expect(groups.map((g) => g.label)).toEqual(['我的任务', '系统任务', 'Agent 自建'])

    const onlyAgent = groupCronJobs([job('agent')])
    expect(onlyAgent.map((g) => g.label)).toEqual(['Agent 自建'])
  })

  it('组内排序：启用优先 → 下次运行近的在前 → 创建时间早的在前', () => {
    const groups = groupCronJobs([
      job('user', { enabled: false, nextRunAt: new Date(2026, 0, 1, 9).toISOString() }),
      job('user', { nextRunAt: new Date(2026, 0, 2, 9).toISOString() }),
      job('user', { nextRunAt: new Date(2026, 0, 1, 10).toISOString() }),
      job('user', { nextRunAt: null, enabled: true }),
    ])
    const names = groups[0].jobs.map((j) => j.nextRunAt)
    expect(names[0]).toBe(new Date(2026, 0, 1, 10).toISOString())
    expect(names[1]).toBe(new Date(2026, 0, 2, 9).toISOString())
    expect(names[2]).toBeNull()
    expect(groups[0].jobs[3].enabled).toBe(false)
  })

  it('空数组返回空分组', () => {
    expect(groupCronJobs([])).toEqual([])
  })
})
