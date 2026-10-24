import { describe, expect, it } from 'vitest'
import { buildTaskMetrics } from './task-metrics'
import type { BackgroundTaskRecord } from './background-task-manager'

function record(overrides: Partial<BackgroundTaskRecord> = {}): BackgroundTaskRecord {
  return {
    taskId: 't1',
    toolName: 'mcp__comfyui__enqueue_workflow',
    label: 'ComfyUI',
    status: 'succeeded',
    startedAt: 1_000,
    endedAt: 61_000,
    ...overrides,
  }
}

describe('buildTaskMetrics', () => {
  it('总耗时与最慢里程碑', () => {
    const metrics = buildTaskMetrics(
      record({
        milestones: [
          { step: '入队', status: 'completed', duration: 500 },
          { step: '排队', status: 'completed', duration: 8_000 },
          { step: '渲染', status: 'completed', duration: 40_000 },
        ],
      }),
    )
    expect(metrics.durationMs).toBe(60_000)
    expect(metrics.slowestMilestone).toMatchObject({ step: '渲染', durationMs: 40_000 })
  })

  it('未结束的任务没有总耗时', () => {
    const metrics = buildTaskMetrics(
      record({ status: 'running', endedAt: undefined }),
    )
    expect(metrics.durationMs).toBeUndefined()
  })

  it('统计 warn/error 日志数，区分「慢」与「重试才慢」', () => {
    const metrics = buildTaskMetrics(
      record({
        logs: [
          { level: 'info', message: 'a', timestamp: 1 },
          { level: 'warn', message: 'b', timestamp: 2 },
          { level: 'warn', message: 'c', timestamp: 3 },
          { level: 'error', message: 'd', timestamp: 4 },
        ],
      }),
    )
    expect(metrics.warningCount).toBe(2)
    expect(metrics.errorCount).toBe(1)
  })

  it('没有耗时数据时不给最慢里程碑', () => {
    const metrics = buildTaskMetrics(
      record({ milestones: [{ step: '执行', status: 'in-progress' }] }),
    )
    expect(metrics.slowestMilestone).toBeUndefined()
    expect(metrics.milestones).toEqual([{ step: '执行', status: 'in-progress' }])
  })
})
