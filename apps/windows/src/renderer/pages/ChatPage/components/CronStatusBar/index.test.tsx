/**
 * CronStatusBar 的会话反查。两条来源：
 * - origin：用户在**本会话**派发的任务（主路径，主会话 id 是 hex 不是 cron: 前缀）
 * - cron 会话名：任务产出落地的独立会话 `cron:<owner>:<name 归一化>`
 *
 * 规则漂移会让状态条在正确的会话上静默消失——值得断言钉住。
 */
import { describe, it, expect } from 'vitest'
import { findCronJobsForSession } from './index'
import type { CronJob } from '../../../../hooks/business/useCron/types'

const job = (name: string, extra: Partial<CronJob> = {}): CronJob =>
  ({ id: name, name, agentId: 'assistant', ...extra }) as CronJob

describe('findCronJobsForSession', () => {
  it('按 origin 命中：主会话（hex id）里能看到自己派的任务', () => {
    const jobs = [job('资源监测', { originConversationId: '27b0357fcebb' })]
    expect(findCronJobsForSession('27b0357fcebb', jobs)?.map((j) => j.name)).toEqual(['资源监测'])
  })

  it('一个会话派了多条任务，全部返回', () => {
    const jobs = [
      job('资源监测', { originConversationId: 'abc' }),
      job('喝水提醒', { originConversationId: 'abc' }),
      job('别的', { originConversationId: 'other' }),
    ]
    expect(findCronJobsForSession('abc', jobs)?.map((j) => j.name)).toEqual(['资源监测', '喝水提醒'])
  })

  it('回退到 cron 独立会话名匹配（含中文任务名）', () => {
    const jobs = [job('资源监测')]
    expect(findCronJobsForSession('cron:assistant:资源监测', jobs)?.length).toBe(1)
  })

  it('任务名里的多空白归一化后仍能对上', () => {
    const jobs = [job('资源   监测')]
    expect(findCronJobsForSession('cron:assistant:资源 监测', jobs)?.length).toBe(1)
  })

  it('无关会话返回空', () => {
    expect(findCronJobsForSession('unrelated', [job('资源监测', { originConversationId: 'abc' })])).toEqual([])
    expect(findCronJobsForSession(null, [job('资源监测')])).toEqual([])
  })

  it('执行者不同则不复用同一条 cron 会话', () => {
    const jobs = [job('资源监测', { agentId: 'chronicler' })]
    expect(findCronJobsForSession('cron:assistant:资源监测', jobs)).toEqual([])
    expect(findCronJobsForSession('cron:chronicler:资源监测', jobs)?.length).toBe(1)
  })
})
