/**
 * CronStatusBar 的会话反查：会话 id 由主进程 cronConversationId 唯一构造
 * （cron:<owner>:<name 空白归一化>），渲染层按同规则拼。规则漂移会让状态条
 * 在正确的会话上静默消失——值得一条断言把它钉住。
 */
import { describe, it, expect } from 'vitest'
import { findCronJobForSession } from './index'
import type { CronJob } from '../../../../hooks/business/useCron/types'

const job = (name: string, agentId = 'assistant'): CronJob =>
  ({ id: 'x', name, agentId }) as CronJob

describe('findCronJobForSession', () => {
  it('命中 cron 会话（含中文任务名）', () => {
    const jobs = [job('资源监测'), job('吃水提醒')]
    expect(findCronJobForSession('cron:assistant:资源监测', jobs)?.name).toBe('资源监测')
  })

  it('任务名里的多空白归一化后仍能对上', () => {
    const jobs = [job('资源   监测')]
    expect(findCronJobForSession('cron:assistant:资源 监测', jobs)?.name).toBe('资源   监测')
  })

  it('非 cron 会话直接返回 undefined', () => {
    expect(findCronJobForSession('27b0357fcebb', [job('资源监测')])).toBeUndefined()
    expect(findCronJobForSession(null, [job('资源监测')])).toBeUndefined()
  })

  it('执行者不同则不复用同一条会话', () => {
    const jobs = [job('资源监测', 'chronicler')]
    expect(findCronJobForSession('cron:assistant:资源监测', jobs)).toBeUndefined()
    expect(findCronJobForSession('cron:chronicler:资源监测', jobs)?.name).toBe('资源监测')
  })
})
