/**
 * useCronJobs - 定时任务 CRUD Hook
 *
 * 通过 Gateway WebSocket 管理定时任务
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { CronJob, CronScheduleType, CreateCronJobParams } from './types'

/**
 * 将后端嵌套 CronJob 格式转换为客户端扁平格式
 *
 * 后端返回：{ schedule: { kind, expr/everyMs/atMs, tz }, state: { lastRunAtMs, ... }, ... }
 * 客户端期望：{ scheduleType, scheduleExpr, scheduleTz, lastRunAt, status, ... }
 */
function normalizeJob(raw: Record<string, unknown>): CronJob {
  // 已经是扁平格式（本地 Cron 任务，有 scheduleType 字段）
  if (typeof raw.scheduleType === 'string' && typeof raw.scheduleExpr === 'string') {
    // 将 lastRunAt (ms number) 转为 ISO string，lastStatus 映射到 status
    const lastRunAtMs = raw.lastRunAt as number | undefined
    const lastStatus = raw.lastStatus as 'ok' | 'error' | 'running' | undefined
    return {
      ...raw as unknown as CronJob,
      lastRunAt: lastRunAtMs ? new Date(lastRunAtMs).toISOString() : (raw.lastRunAt as string | null | undefined) ?? null,
      // nextRunAt 来自 nextRunAt (ms number)
      nextRunAt: raw.nextRunAt ? new Date(raw.nextRunAt as number).toISOString() : null,
      status: lastStatus ?? (raw.status as CronJob['status']) ?? 'idle',
      updatedAt: raw.updatedAt as string ?? (raw.createdAt as string) ?? '',
    }
  }

  const schedule = raw.schedule as Record<string, unknown> | undefined
  const state = raw.state as Record<string, unknown> | undefined
  const payload = raw.payload as Record<string, unknown> | undefined

  let scheduleType: CronScheduleType = 'cron'
  let scheduleExpr = ''
  let scheduleTz: string | undefined

  if (schedule) {
    const kind = schedule.kind as string
    scheduleType = kind === 'at' ? 'at' : kind === 'every' ? 'every' : 'cron'

    if (kind === 'at') {
      scheduleExpr = String(schedule.atMs ?? '')
    } else if (kind === 'every') {
      scheduleExpr = String(schedule.everyMs ?? '')
    } else {
      scheduleExpr = (schedule.expr as string) ?? ''
      scheduleTz = schedule.tz as string | undefined
    }
  }

  return {
    id: raw.id as string,
    userId: (raw.userId as string) ?? '',
    agentId: (raw.agentId as string) ?? '',
    name: (raw.name as string) ?? '',
    description: raw.description as string | undefined,
    enabled: (raw.enabled as boolean) ?? true,
    scheduleType,
    scheduleExpr,
    scheduleTz,
    taskText: (payload?.message as string) ?? (payload?.text as string) ?? '',
    status: (state?.lastStatus as CronJob['status']) ?? (raw.status as CronJob['status']) ?? 'idle',
    lastRunAt: state?.lastRunAtMs ? new Date(state.lastRunAtMs as number).toISOString() : undefined,
    nextRunAt: state?.nextRunAtMs ? new Date(state.nextRunAtMs as number).toISOString() : undefined,
    lastError: state?.lastError as string | undefined,
    consecutiveErrors: (state?.consecutiveErrors as number) ?? 0,
    lastDurationMs: state?.lastDurationMs as number | undefined,
    createdAt: raw.createdAtMs
      ? new Date(raw.createdAtMs as number).toISOString()
      : (raw.createdAt as string) ?? '',
    updatedAt: raw.updatedAtMs
      ? new Date(raw.updatedAtMs as number).toISOString()
      : (raw.updatedAt as string) ?? '',
  }
}

export function useCronJobs() {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const fetchingRef = useRef(false)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 获取任务列表
   * @param includeDisabled 是否包含已禁用（已执行）的任务，默认 true
   * @param silent 静默刷新（不触发 loading 状态，用于轮询），默认 false
   */
  const fetchJobs = useCallback(async (includeDisabled = true, silent = false) => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    if (!silent) setLoading(true)
    setError(null)

    try {
      const result = await window.electronAPI.agentRuntime.sendCommand({
        type: 'cron:list',
        includeDisabled,
      }) as { jobs: Record<string, unknown>[] }
      setJobs((result?.jobs ?? []).map(normalizeJob))
    } catch (err) {
      const msg = err instanceof Error ? err.message : '获取任务列表失败'
      setError(msg)
    } finally {
      if (!silent) setLoading(false)
      fetchingRef.current = false
    }
  }, [])

  /** 创建任务 */
  const addJob = useCallback(async (data: CreateCronJobParams): Promise<CronJob | null> => {
    try {
      const created = await window.electronAPI.agentRuntime.sendCommand({
        type: 'cron:create',
        name: data.name,
        taskText: data.taskText,
        scheduleType: data.scheduleType,
        scheduleExpr: data.scheduleExpr,
        agentId: data.agentId,
      }) as { status: 'ok' | 'error'; job?: Record<string, unknown> }
      if (created.status !== 'ok') {
        setError((created as { message?: string }).message ?? '创建任务失败')
        return null
      }
      await fetchJobs()
      return created.job ? normalizeJob(created.job) : null
    } catch (err) {
      const msg = err instanceof Error ? err.message : '创建任务失败'
      setError(msg)
      return null
    }
  }, [fetchJobs])

  /** 更新任务 */
  const updateJob = useCallback(async (id: string, patch: Partial<CronJob>): Promise<boolean> => {
    try {
      const result = await window.electronAPI.agentRuntime.sendCommand({
        type: 'cron:update',
        id,
        patch: {
          enabled: typeof patch.enabled === 'boolean' ? patch.enabled : undefined,
          name: typeof patch.name === 'string' ? patch.name : undefined,
          taskText: typeof patch.taskText === 'string' ? patch.taskText : undefined,
          scheduleType: patch.scheduleType,
          scheduleExpr: patch.scheduleExpr,
        },
      }) as { status?: 'ok' | 'not_found' | 'error'; message?: string }
      if (result.status && result.status !== 'ok') {
        setError(result.message ?? '更新任务失败')
        return false
      }
      await fetchJobs()
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : '更新任务失败'
      setError(msg)
      return false
    }
  }, [fetchJobs])

  /** 删除任务 */
  const removeJob = useCallback(async (id: string): Promise<boolean> => {
    try {
      await window.electronAPI.agentRuntime.sendCommand({ type: 'cron:delete', id })
      setJobs(prev => prev.filter(j => j.id !== id))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : '删除任务失败'
      setError(msg)
      return false
    }
  }, [])

  /** 批量删除任务 */
  const removeJobs = useCallback(async (ids: string[]): Promise<{ success: string[]; failed: string[] }> => {
    const success: string[] = []
    const failed: string[] = []
    for (const id of ids) {
      try {
        await window.electronAPI.agentRuntime.sendCommand({ type: 'cron:delete', id })
        success.push(id)
      } catch {
        failed.push(id)
      }
    }
    if (success.length > 0) {
      setJobs(prev => prev.filter(j => !success.includes(j.id)))
    }
    return { success, failed }
  }, [])

  /** 手动触发执行 */
  const runJob = useCallback(async (id: string, force = false): Promise<boolean> => {
    try {
      void force
      await window.electronAPI.agentRuntime.sendCommand({ type: 'cron:run', id })
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : '触发执行失败'
      setError(msg)
      return false
    }
  }, [])

  /** 切换启用/禁用 */
  const toggleJob = useCallback(async (id: string, enabled: boolean): Promise<boolean> => {
    return updateJob(id, { enabled } as Partial<CronJob>)
  }, [updateJob])

  // 初始加载
  useEffect(() => {
    void fetchJobs()
  }, [fetchJobs])

  // 本地 Runtime 模式下使用轻量轮询，避免依赖网关事件通道
  useEffect(() => {
    const pollTimer = setInterval(() => {
      // 轮询保护：当用户正在请求中时不叠加
      if (!fetchingRef.current) {
        void fetchJobs(true, true)
      }
    }, 5000)

    return () => {
      clearInterval(pollTimer)
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [fetchJobs])

  return {
    jobs,
    loading,
    error,
    fetchJobs,
    addJob,
    updateJob,
    removeJob,
    removeJobs,
    runJob,
    toggleJob,
  }
}
