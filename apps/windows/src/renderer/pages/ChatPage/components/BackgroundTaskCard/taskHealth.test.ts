/**
 * 后台任务健康态与本步计时单元测试。
 */

import { describe, expect, it } from 'vitest'
import {
  deriveTaskHealth,
  findActiveMilestone,
  hasAlertLogs,
  resolveLatestActivityAt,
  resolveStepWaitStart,
  STUCK_STEP_MS,
} from './taskHealth'

describe('taskHealth', () => {
  it('定位进行中里程碑并解析本步起点', () => {
    expect(findActiveMilestone([
      { step: 'a', status: 'completed', startTime: 1 },
      { step: 'b', status: 'in-progress', startTime: 50 },
    ])?.step).toBe('b')
    expect(resolveStepWaitStart(10, [
      { step: 'b', status: 'in-progress', startTime: 50 },
    ])).toBe(50)
    expect(resolveStepWaitStart(10, [])).toBe(10)
  })

  it('最近活动取本步起点与最新日志的较大值', () => {
    expect(resolveLatestActivityAt({
      startedAt: 10,
      milestones: [{ step: 'b', status: 'in-progress', startTime: 50 }],
      logs: [{ level: 'info', message: 'x', timestamp: 80 }],
    })).toBe(80)
  })

  it('按 error / warn / stuck 推导健康态；有近期日志不算卡住', () => {
    expect(deriveTaskHealth({
      status: 'failed',
      startedAt: 1,
      logs: [],
    })).toBe('error')
    expect(deriveTaskHealth({
      status: 'running',
      startedAt: 1,
      logs: [{ level: 'error', message: 'x', timestamp: 1 }],
    })).toBe('error')
    expect(deriveTaskHealth({
      status: 'running',
      startedAt: 1_000,
      logs: [{ level: 'warn', message: 'slow', timestamp: 1_000 }],
      milestones: [{ step: '渲染', status: 'in-progress', startTime: 1_000 }],
      now: 1_000 + 60_000,
    })).toBe('warn')
    expect(deriveTaskHealth({
      status: 'running',
      startedAt: 1_000,
      milestones: [{ step: '渲染', status: 'in-progress', startTime: 1_000 }],
      now: 1_000 + STUCK_STEP_MS,
    })).toBe('stuck')
    // 同一步已超过阈值，但最近有日志 → 仍视为有警告/正常，不算 stuck
    expect(deriveTaskHealth({
      status: 'running',
      startedAt: 1_000,
      logs: [{ level: 'info', message: '仍在渲染', timestamp: 1_000 + STUCK_STEP_MS - 1_000 }],
      milestones: [{ step: '渲染', status: 'in-progress', startTime: 1_000 }],
      now: 1_000 + STUCK_STEP_MS,
    })).toBe('ok')
    expect(deriveTaskHealth({
      status: 'running',
      startedAt: 1_000,
      milestones: [{ step: '渲染', status: 'in-progress', startTime: 1_000 }],
      now: 1_000 + 30_000,
    })).toBe('ok')
  })

  it('识别告警日志', () => {
    expect(hasAlertLogs([{ level: 'info', message: 'a', timestamp: 1 }])).toBe(false)
    expect(hasAlertLogs([{ level: 'warn', message: 'a', timestamp: 1 }])).toBe(true)
    expect(hasAlertLogs([{ level: 'error', message: 'a', timestamp: 1 }])).toBe(true)
  })
})
