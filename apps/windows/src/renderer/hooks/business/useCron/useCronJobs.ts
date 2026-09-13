/**
 * useCronJobs - 定时任务 CRUD Hook
 *
 * 经 agent-runtime IPC 命令通道（cron:list/create/update/delete/run/runs）管理本地定时任务
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { CronJob, CreateCronJobParams } from './types'

/**
 * 规范化后端返回的扁平 CronJob：ms 时间戳转 ISO 字符串、lastStatus 映射到 status。
 * 来源/受管字段缺失时兜底为 user / null（旧数据或非列表接口的返回）。
 */
function normalizeJob(raw: Record<string, unknown>): CronJob {
  const lastRunAtMs = raw.lastRunAt as number | undefined
  const lastStatus = raw.lastStatus as 'ok' | 'error' | 'running' | undefined
  return {
    ...raw as unknown as CronJob,
    lastRunAt: lastRunAtMs ? new Date(lastRunAtMs).toISOString() : (raw.lastRunAt as string | null | undefined) ?? null,
    nextRunAt: raw.nextRunAt ? new Date(raw.nextRunAt as number).toISOString() : null,
    status: lastStatus ?? (raw.status as CronJob['status']) ?? 'idle',
    updatedAt: raw.updatedAt as string ?? (raw.createdAt as string) ?? '',
    source: (raw.source as CronJob['source']) ?? 'user',
    managedBy: (raw.managedBy as CronJob['managedBy']) ?? null,
    reseeded: (raw.reseeded as boolean) ?? false,
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
        activeDays: data.activeDays,
        activeHourStart: data.activeHourStart ?? undefined,
        activeHourEnd: data.activeHourEnd ?? undefined,
        notifyTargets: data.notifyTargets,
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
          agentId: typeof patch.agentId === 'string' ? patch.agentId : undefined,
          scheduleType: patch.scheduleType,
          scheduleExpr: patch.scheduleExpr,
          activeDays: typeof patch.activeDays === 'string' ? patch.activeDays : undefined,
          activeHourStart: patch.activeHourStart,
          activeHourEnd: patch.activeHourEnd,
          notifyTargets: typeof patch.notifyTargets === 'string' ? patch.notifyTargets : undefined,
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
