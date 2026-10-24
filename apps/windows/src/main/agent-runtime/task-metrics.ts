/**
 * 后台任务性能指标。
 *
 * 只回答「这个任务慢在哪」：各里程碑耗时、总耗时、重试次数、峰值资源。
 * 全部从任务记录派生，不新增控制流；采集点在 BackgroundTaskManager 的生命周期钩子上。
 *
 * 落盘是 opt-in 的：默认只在内存里留最近 N 条，宿主给了 sink 才写文件。
 */

import type { BackgroundTaskRecord } from './background-task-manager'

export interface MilestoneMetric {
  readonly step: string
  readonly status: string
  readonly durationMs?: number
}

export interface TaskPerformanceMetrics {
  readonly taskId: string
  readonly toolName: string
  readonly status: string
  readonly startedAt: number
  readonly endedAt?: number
  /** 总耗时；未结束为 undefined */
  readonly durationMs?: number
  readonly milestones: readonly MilestoneMetric[]
  /** 最慢的一个里程碑（排障时最先看这个） */
  readonly slowestMilestone?: MilestoneMetric
  /** 期间产生的 warn/error 日志条数，用于区分「慢」和「出错重试才慢」 */
  readonly warningCount: number
  readonly errorCount: number
}

/** 从任务记录派生性能指标 */
export function buildTaskMetrics(record: BackgroundTaskRecord): TaskPerformanceMetrics {
  const milestones: MilestoneMetric[] = (record.milestones ?? []).map((milestone) => ({
    step: milestone.step,
    status: milestone.status,
    ...(milestone.duration !== undefined ? { durationMs: milestone.duration } : {}),
  }))
  const slowestMilestone = milestones.reduce<MilestoneMetric | undefined>(
    (slowest, current) =>
      current.durationMs !== undefined && current.durationMs > (slowest?.durationMs ?? -1)
        ? current
        : slowest,
    undefined,
  )
  const logs = record.logs ?? []
  return {
    taskId: record.taskId,
    toolName: record.toolName,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.endedAt !== undefined
      ? { durationMs: Math.max(0, record.endedAt - record.startedAt) }
      : {}),
    milestones,
    ...(slowestMilestone ? { slowestMilestone } : {}),
    warningCount: logs.filter((log) => log.level === 'warn').length,
    errorCount: logs.filter((log) => log.level === 'error').length,
  }
}
