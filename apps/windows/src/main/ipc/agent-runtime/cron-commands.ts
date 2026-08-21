/**
 * Cron 命令处理器（cron:*）
 *
 * 本地定时任务管理：创建、列表、删除、更新、立即执行、运行历史
 */

import { Cron } from 'croner'
import { randomUUID } from 'node:crypto'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'

const log = {
  info: (...args: unknown[]) => console.log('[agent-runtime-ipc/cron]', ...args),
  error: (...args: unknown[]) => console.error('[agent-runtime-ipc/cron]', ...args),
}

// ============================================================
// 辅助函数
// ============================================================

function parseStrictMs(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

/**
 * 简化版 at 时间表达式解析（支持 ms/秒级/ISO）。
 */
function parseAtScheduleExprLite(rawExpr: string): number | undefined {
  const direct = parseStrictMs(rawExpr)
  if (direct !== undefined) {
    return direct > 0 && direct < 1_000_000_000_000 ? direct * 1000 : direct
  }
  const iso = Date.parse(rawExpr)
  if (Number.isFinite(iso)) return iso
  return undefined
}

function resolveLocalCronSchedule(
  scheduleType: 'at' | 'every' | 'cron',
  scheduleExpr: string,
  now: number,
): { ok: boolean; nextRunAt?: number; intervalMs?: number; message?: string } {
  if (scheduleType === 'at') {
    const ts = parseAtScheduleExprLite(scheduleExpr)
    if (!ts) {
      return { ok: false, message: `无效的 at 时间表达式: ${scheduleExpr}` }
    }
    if (ts < now) {
      return { ok: false, message: `at 时间已过期: ${new Date(ts).toISOString()}` }
    }
    return { ok: true, nextRunAt: ts }
  }
  if (scheduleType === 'every') {
    const ms = parseStrictMs(scheduleExpr)
    if (!ms || ms < 1000) {
      return { ok: false, message: `无效的 every 间隔（最小 1000ms）: ${scheduleExpr}` }
    }
    return { ok: true, nextRunAt: now + ms, intervalMs: ms }
  }
  if (scheduleType === 'cron') {
    try {
      const pattern = new Cron(scheduleExpr, { paused: true })
      const next = pattern.nextRun()
      if (!next) {
        return { ok: false, message: `cron 表达式无下次运行: ${scheduleExpr}` }
      }
      return { ok: true, nextRunAt: next.getTime() }
    } catch (err) {
      return { ok: false, message: `cron 表达式解析失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { ok: false, message: `未知 scheduleType: ${scheduleType}` }
}

// ============================================================
// 命令处理器
// ============================================================

export function handleCronCreate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'cron:create' }>,
): { status: 'ok' | 'error'; job?: { id: string; name: string; scheduleType: 'at' | 'every' | 'cron'; scheduleExpr: string; nextRunAt?: number; intervalMs?: number; enabled: boolean }; message?: string } {
  const name = command.name.trim()
  const taskText = command.taskText.trim()
  const scheduleExpr = command.scheduleExpr.trim()
  if (!name || !taskText || !scheduleExpr) {
    return { status: 'error', message: 'name/taskText/scheduleExpr is required' }
  }

  const now = Date.now()
  const schedule = resolveLocalCronSchedule(command.scheduleType, scheduleExpr, now)
  if (!schedule.ok) {
    return { status: 'error', message: schedule.message }
  }

  const id = randomUUID()
  bridge.createLocalCronJobRecord({
    id,
    name,
    taskText,
    agentId: command.agentId ?? undefined,
    scheduleType: command.scheduleType,
    scheduleExpr,
    nextRunAt: schedule.nextRunAt ?? now,
    intervalMs: schedule.intervalMs ?? undefined,
    enabled: true,
    createdAt: now,
    activeDays: command.activeDays ?? undefined,
    activeHourStart: command.activeHourStart ?? undefined,
    activeHourEnd: command.activeHourEnd ?? undefined,
    notifyTargets: command.notifyTargets ?? undefined,
  })

  log.info(`[cron:create] 创建定时任务: id=${id} name="${name}" type=${command.scheduleType} expr="${scheduleExpr}"`)

  return {
    status: 'ok',
    job: {
      id,
      name,
      scheduleType: command.scheduleType,
      scheduleExpr,
      nextRunAt: schedule.nextRunAt,
      intervalMs: schedule.intervalMs,
      enabled: true,
    },
  }
}

export function handleCronList(
  bridge: AgentRuntimeBridge,
  includeDisabled: boolean,
): { status: 'ok'; jobs: Array<{ id: string; name: string; taskText: string; agentId?: string; scheduleType: 'at' | 'every' | 'cron'; scheduleExpr: string; nextRunAt: number; intervalMs?: number; enabled: boolean; createdAt: number; lastRunAt?: number; lastStatus?: 'ok' | 'error' | 'running'; activeDays?: string; activeHourStart?: number; activeHourEnd?: number; notifyTargets?: string }>; total: number } {
  const rows = bridge.listLocalCronJobRecords(includeDisabled)
  return {
    status: 'ok',
    jobs: rows.map((r) => ({
      id: r.id,
      name: r.name,
      taskText: r.task_text,
      agentId: r.agent_id ?? undefined,
      scheduleType: r.schedule_type,
      scheduleExpr: r.schedule_expr,
      nextRunAt: r.next_run_at,
      intervalMs: r.interval_ms ?? undefined,
      enabled: r.enabled === 1,
      createdAt: r.created_at,
      ...(r.last_run_at != null ? { lastRunAt: r.last_run_at } : {}),
      ...(r.last_status != null ? { lastStatus: r.last_status } : {}),
      ...(r.active_days != null ? { activeDays: r.active_days } : {}),
      ...(r.active_hour_start != null ? { activeHourStart: r.active_hour_start } : {}),
      ...(r.active_hour_end != null ? { activeHourEnd: r.active_hour_end } : {}),
      ...(r.notify_targets != null ? { notifyTargets: r.notify_targets } : {}),
    })),
    total: rows.length,
  }
}

export function handleCronDelete(
  bridge: AgentRuntimeBridge,
  id: string,
): { status: 'ok' | 'error'; id: string; message?: string } {
  const row = bridge.getLocalCronJobRecordById(id)
  if (!row) {
    return { status: 'error', id, message: `定时任务不存在: ${id}` }
  }
  bridge.deleteLocalCronJobRecord(id)
  log.info(`[cron:delete] 删除定时任务: id=${id} name="${row.name}"`)
  return { status: 'ok', id }
}

export function handleCronUpdate(
  bridge: AgentRuntimeBridge,
  id: string,
  patch: { name?: string; taskText?: string; agentId?: string | null; scheduleType?: 'at' | 'every' | 'cron'; scheduleExpr?: string; enabled?: boolean; activeDays?: string | null; activeHourStart?: number | null; activeHourEnd?: number | null; notifyTargets?: string | null },
): { status: 'ok' | 'error'; id: string; message?: string } {
  const row = bridge.getLocalCronJobRecordById(id)
  if (!row) {
    return { status: 'error', id, message: `定时任务不存在: ${id}` }
  }

  const nextScheduleType = patch.scheduleType ?? row.schedule_type
  const nextScheduleExpr = patch.scheduleExpr ?? row.schedule_expr

  let nextRunAt = row.next_run_at
  let intervalMs = row.interval_ms
  if (patch.scheduleType || patch.scheduleExpr) {
    const schedule = resolveLocalCronSchedule(nextScheduleType, nextScheduleExpr, Date.now())
    if (!schedule.ok) {
      return { status: 'error', id, message: schedule.message }
    }
    nextRunAt = schedule.nextRunAt ?? row.next_run_at
    intervalMs = schedule.intervalMs ?? null
  }

  bridge.updateLocalCronJobRecord({
    id,
    name: patch.name ?? row.name,
    taskText: patch.taskText ?? row.task_text,
    agentId: patch.agentId !== undefined ? patch.agentId ?? undefined : row.agent_id ?? undefined,
    scheduleType: nextScheduleType,
    scheduleExpr: nextScheduleExpr,
    nextRunAt,
    intervalMs: intervalMs ?? undefined,
    enabled: patch.enabled !== undefined ? patch.enabled : row.enabled === 1,
    activeDays: patch.activeDays !== undefined ? patch.activeDays : row.active_days ?? undefined,
    activeHourStart: patch.activeHourStart !== undefined ? patch.activeHourStart : row.active_hour_start ?? undefined,
    activeHourEnd: patch.activeHourEnd !== undefined ? patch.activeHourEnd : row.active_hour_end ?? undefined,
    notifyTargets: patch.notifyTargets !== undefined ? patch.notifyTargets : row.notify_targets ?? undefined,
  })

  log.info(`[cron:update] 更新定时任务: id=${id} patch=${JSON.stringify(patch)}`)
  return { status: 'ok', id }
}

export async function handleCronRun(
  bridge: AgentRuntimeBridge,
  id: string,
): Promise<{ status: 'ok' | 'error'; id: string; message?: string }> {
  const row = bridge.getLocalCronJobRecordById(id)
  if (!row) {
    return { status: 'error', id, message: `定时任务不存在: ${id}` }
  }
  log.info(`[cron:run] 立即执行定时任务: id=${id} name="${row.name}"`)

  try {
    await bridge.runCronJobManually(row)
    return { status: 'ok', id }
  } catch (err) {
    log.error(`[cron:run] 执行失败: id=${id}`, err)
    return { status: 'error', id, message: err instanceof Error ? err.message : String(err) }
  }
}

export function handleCronRuns(
  bridge: AgentRuntimeBridge,
  id: string,
  limit: number,
): { status: 'ok'; entries: Array<{ id: string; status: 'ok' | 'error'; startedAt: number; finishedAt: number; durationMs: number; summary?: string; error?: string }> } {
  const rows = bridge.listLocalCronRuns(id, limit)
  return {
    status: 'ok',
    entries: rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
      status: r.status,
      ...(r.summary != null ? { summary: r.summary } : {}),
      ...(r.error != null ? { error: r.error } : {}),
    })),
  }
}
