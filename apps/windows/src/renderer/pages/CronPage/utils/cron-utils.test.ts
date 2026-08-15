import { describe, expect, it } from 'vitest'
import { describeCron } from './cron-utils'
import type { CronJob } from '../../../hooks/business/useCron/types'

/** 只有 describeCron 用到的字段是必需的，其余补齐以满足类型 */
function job(patch: Partial<CronJob>): CronJob {
  return {
    id: 'j1',
    name: '测试任务',
    taskText: '做点事',
    scheduleType: 'cron',
    scheduleExpr: '',
    enabled: true,
    nextRunAt: 0,
    createdAt: 0,
    ...patch,
  } as CronJob
}

describe('describeCron', () => {
  it('cron 表达式不外泄到界面', () => {
    // 非法/无法识别的表达式也必须是中文描述
    expect(describeCron(job({ scheduleExpr: 'not a cron' }))).toBe('自定义计划')
    expect(describeCron(job({ scheduleExpr: '30 8 * * 1,2,3,4,5' }))).not.toContain('*')
  })

  it('逗号列举的工作日简写成「工作日」', () => {
    expect(describeCron(job({ scheduleExpr: '30 8 * * 1,2,3,4,5' }))).toBe('工作日 08:30')
    expect(describeCron(job({ scheduleExpr: '0 18 * * 1-5' }))).toBe('工作日 18:00')
  })

  it('单个星期与周末', () => {
    expect(describeCron(job({ scheduleExpr: '0 17 * * 5' }))).toBe('周五 17:00')
    expect(describeCron(job({ scheduleExpr: '0 20 * * 0,6' }))).toBe('周末 20:00')
  })

  it('每天与每月', () => {
    expect(describeCron(job({ scheduleExpr: '0 9 * * *' }))).toBe('每天 09:00')
    expect(describeCron(job({ scheduleExpr: '0 9 1 * *' }))).toBe('每月 1 日 09:00')
  })

  it('按间隔带上生效窗口', () => {
    const interval = job({
      scheduleType: 'every',
      scheduleExpr: String(2 * 60 * 60 * 1000),
      activeDays: '1,2,3,4,5',
      activeHourStart: 10,
      activeHourEnd: 18,
    })
    expect(describeCron(interval)).toBe('每 2小时（工作日 10:00-18:00）')
  })

  it('全选七天不赘述窗口', () => {
    const everyday = job({
      scheduleType: 'every',
      scheduleExpr: String(60 * 60 * 1000),
      activeDays: '0,1,2,3,4,5,6',
    })
    expect(describeCron(everyday)).toBe('每 1小时')
  })

  it('一次性任务显示具体时刻', () => {
    const at = new Date(2026, 7, 10, 9, 30).getTime()
    expect(describeCron(job({ scheduleType: 'at', scheduleExpr: String(at) }))).toContain('一次性')
  })
})
