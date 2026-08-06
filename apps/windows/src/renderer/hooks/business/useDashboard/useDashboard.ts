/**
 * useDashboard.ts - 概览页数据 Hook
 *
 * 全部数据来自本机：system:getInfo / system:getDiskInfo / usage:query / skills:listLocalInstalled。
 * 延迟读数不在这里——它只在底栏 HUD 出现一次（StatusBar 自己拉 usage:latency）。
 * 不再依赖登录态——本产品无账号体系，原先 `enabled: isAuthenticated` 会让所有查询永不执行。
 */

import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '../../common/useQuery'
import type { RuntimeGauges, SkillStats, UsageRange, UsageView } from './useDashboard.types'

/** 系统信息轮询间隔。CPU 是两次采样差分，间隔即统计窗口 */
const SYSTEM_POLL_MS = 3000
/** 磁盘信息主进程侧有 30s 缓存，这里同频轮询即可 */
const DISK_POLL_MS = 30000

type SystemInfoShape = {
  cpuUsage?: number
  memoryUsagePercent?: number
  cpuModel?: string
  cpuCores?: number
  totalMemory?: number
  usedMemory?: number
}

type DiskShape = { mount?: string; usagePercent?: number }

/** 区间起止（epoch ms）与桶粒度 */
function resolveRange(range: UsageRange): { from: number; to: number; groupBy: 'hour' | 'day' } {
  const now = new Date()
  const to = now.getTime() + 1
  if (range === 'today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return { from: start.getTime(), to, groupBy: 'hour' }
  }
  const days = range === '7d' ? 7 : 30
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  return { from: start.getTime(), to, groupBy: 'day' }
}

export function useDashboard() {
  const [usageRange, setUsageRange] = useState<UsageRange>('today')

  const fetchSystem = useCallback(async (): Promise<SystemInfoShape | null> => {
    const info = (await window.electronAPI.system.getInfo()) as SystemInfoShape | null
    return info ?? null
  }, [])

  const fetchDisk = useCallback(async (): Promise<number | undefined> => {
    const disks = (await window.electronAPI.system.getDiskInfo()) as DiskShape[] | null
    if (!disks?.length) return undefined
    // 取 C 盘，取不到就退回第一块——概览只需要一个「系统盘」代表值
    const target = disks.find((d) => d.mount?.toUpperCase().startsWith('C')) ?? disks[0]
    return target?.usagePercent
  }, [])

  const fetchSkills = useCallback(async (): Promise<SkillStats> => {
    const raw = await window.electronAPI.skills.listLocalInstalled()
    const list: unknown[] = Array.isArray(raw)
      ? raw
      : ((raw as { data?: unknown[] } | null)?.data ?? [])
    return { installed: list.length }
  }, [])

  const { from, to, groupBy } = useMemo(() => resolveRange(usageRange), [usageRange])

  const fetchUsage = useCallback(async (): Promise<UsageView> => {
    const res = await window.electronAPI.usage.query({ from, to, groupBy })
    if (!res.success || !res.data) {
      throw new Error(res.error || '查询用量失败')
    }
    return { ...res.data, buckets: [...res.data.buckets], groupBy }
  }, [from, to, groupBy])

  const {
    data: systemInfo,
    isLoading: isSystemLoading,
    refetch: refetchSystem,
  } = useQuery<SystemInfoShape | null>({
    queryKey: ['dashboard', 'system'],
    queryFn: fetchSystem,
    refetchInterval: SYSTEM_POLL_MS,
    retryCount: 0,
  })

  const { data: diskPercent, refetch: refetchDisk } = useQuery<number | undefined>({
    queryKey: ['dashboard', 'disk'],
    queryFn: fetchDisk,
    refetchInterval: DISK_POLL_MS,
    retryCount: 0,
  })

  const {
    data: skillStats,
    isLoading: isSkillLoading,
    refetch: refetchSkills,
  } = useQuery<SkillStats>({
    queryKey: ['dashboard', 'skills'],
    queryFn: fetchSkills,
    retryCount: 0,
  })

  const {
    data: usage,
    isLoading: isUsageLoading,
    isRefetching: isUsageRefetching,
    error: usageError,
    refetch: refetchUsage,
  } = useQuery<UsageView>({
    // range 进 queryKey，切区间自动重查
    queryKey: ['dashboard', 'usage', usageRange],
    queryFn: fetchUsage,
    retryCount: 0,
  })

  const gauges: RuntimeGauges = useMemo(
    () => ({
      cpuPercent: systemInfo?.cpuUsage,
      memoryPercent: systemInfo?.memoryUsagePercent,
      // useQuery 未取数时 data 为 null，统一成 undefined 表达「无数据」
      diskPercent: diskPercent ?? undefined,
      cpuModel: systemInfo?.cpuModel,
      cpuCores: systemInfo?.cpuCores,
      totalMemory: systemInfo?.totalMemory,
      usedMemory: systemInfo?.usedMemory,
    }),
    [systemInfo, diskPercent],
  )

  const refresh = useCallback(async () => {
    await Promise.all([refetchSystem(), refetchDisk(), refetchSkills(), refetchUsage()])
  }, [refetchSystem, refetchDisk, refetchSkills, refetchUsage])

  return {
    gauges,
    skillStats: skillStats ?? { installed: 0 },
    usage: usage ?? null,
    usageRange,
    setUsageRange,
    isLoading: isSystemLoading || isSkillLoading || isUsageLoading,
    isRefreshing: isUsageRefetching,
    error: usageError,
    refresh,
  }
}

export type UseDashboardReturn = ReturnType<typeof useDashboard>
