/**
 * 后台任务健康态与本步计时。
 *
 * 无 emoji：用文案标签驱动 UI（正常 / 有警告 / 异常 / 疑似卡住）。
 */

import type { Milestone, TaskLog } from '../../../../../shared/agent-runtime-events'
import type { BackgroundTaskStatus } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'

/** 最近活动超过此时长且仍在跑 → 疑似卡住 */
export const STUCK_STEP_MS = 3 * 60 * 1000

export type TaskHealth = 'ok' | 'warn' | 'error' | 'stuck'

export const HEALTH_LABEL: Record<TaskHealth, string> = {
  ok: '正常',
  warn: '有警告',
  error: '异常',
  stuck: '疑似卡住',
}

/** 找当前进行中的里程碑 */
export function findActiveMilestone(
  milestones: readonly Milestone[] | undefined,
): Milestone | undefined {
  return milestones?.find((milestone) => milestone.status === 'in-progress')
}

/**
 * 本步已等待的起点。
 * 优先用进行中里程碑的 startTime，否则回退到任务 startedAt。
 */
export function resolveStepWaitStart(
  startedAt: number,
  milestones: readonly Milestone[] | undefined,
): number {
  const active = findActiveMilestone(milestones)
  return active?.startTime ?? startedAt
}

/**
 * 最近活动时间：取本步起点与最新日志时间戳的较大值。
 * 有新日志时不应判 stuck，避免长渲染步骤误报。
 */
export function resolveLatestActivityAt(input: {
  startedAt: number
  logs?: readonly TaskLog[]
  milestones?: readonly Milestone[]
}): number {
  let latest = resolveStepWaitStart(input.startedAt, input.milestones)
  for (const log of input.logs ?? []) {
    if (log.timestamp > latest) latest = log.timestamp
  }
  return latest
}

/** 根据日志、里程碑与最近活动时间推导健康态 */
export function deriveTaskHealth(input: {
  status: BackgroundTaskStatus
  startedAt?: number
  logs?: readonly TaskLog[]
  milestones?: readonly Milestone[]
  now?: number
}): TaskHealth {
  const now = input.now ?? Date.now()
  const hasFailedMilestone = input.milestones?.some((milestone) => milestone.status === 'failed')
  const hasErrorLog = input.logs?.some((log) => log.level === 'error')
  if (input.status === 'failed' || hasFailedMilestone || hasErrorLog) return 'error'

  if (input.status === 'running') {    const startedAt = input.startedAt ?? resolveStepWaitStart(0, input.milestones)
    const activityAt = resolveLatestActivityAt({
      startedAt,
      logs: input.logs,
      milestones: input.milestones,
    })
    if (now - activityAt >= STUCK_STEP_MS) return 'stuck'
  }

  if (input.logs?.some((log) => log.level === 'warn')) return 'warn'
  return 'ok'
}

/** 是否存在需默认展开日志的告警级别 */
export function hasAlertLogs(logs: readonly TaskLog[] | undefined): boolean {
  return Boolean(logs?.some((log) => log.level === 'warn' || log.level === 'error'))
}
