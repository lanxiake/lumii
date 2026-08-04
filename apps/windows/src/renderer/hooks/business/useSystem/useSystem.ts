/**
 * useSystem.ts - 系统监控 Hook
 *
 * 基于 useSystemMonitor.ts 重构
 * 提供 CPU/内存/磁盘信息和进程列表
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useQuery } from '../../common/useQuery'
import type { SystemInfo, DiskInfo, ProcessInfo, ProcessSortBy } from './useSystem.types'

const DEFAULT_REFRESH_INTERVAL = 3000

export function useSystem() {
  const [refreshInterval, setRefreshInterval] = useState(DEFAULT_REFRESH_INTERVAL)
  const [processSortBy, setProcessSortBy] = useState<ProcessSortBy>('cpu')
  const [processSortOrder, setProcessSortOrder] = useState<'asc' | 'desc'>('desc')
  const [processFilter, setProcessFilter] = useState('')
  const refreshTimerRef = useRef<number | null>(null)

  // 使用 useQuery 获取系统信息
  const {
    data: systemInfo,
    isLoading: isSystemLoading,
    error: systemError,
    refetch: refetchSystem,
  } = useQuery<SystemInfo | null>({
    queryKey: ['system', 'info'],
    queryFn: async () => {
      const info = await window.electronAPI.system.getInfo()
      return info as SystemInfo
    },
  })

  // 使用 useQuery 获取磁盘信息
  const {
    data: disks = [],
    isLoading: isDisksLoading,
    refetch: refetchDisks,
  } = useQuery<DiskInfo[]>({
    queryKey: ['system', 'disks'],
    queryFn: async () => {
      const disks = await window.electronAPI.system.getDiskInfo()
      return disks as DiskInfo[]
    },
  })

  // 使用 useQuery 获取进程列表
  const {
    data: processes = [],
    isLoading: isProcessesLoading,
    refetch: refetchProcesses,
  } = useQuery<ProcessInfo[]>({
    queryKey: ['system', 'processes'],
    queryFn: async () => {
      const processes = await window.electronAPI.system.getProcessList()
      return (processes as ProcessInfo[]).map((p) => ({
        ...p,
        startTime: p.startTime ? new Date(p.startTime) : undefined,
      }))
    },
  })

  // 刷新所有数据
  const refresh = useCallback(async () => {
    await Promise.all([refetchSystem(), refetchDisks(), refetchProcesses()])
  }, [refetchSystem, refetchDisks, refetchProcesses])

  // 设置进程排序
  const setProcessSorting = useCallback((sortBy: ProcessSortBy) => {
    setProcessSortBy((prev) => {
      setProcessSortOrder((order) =>
        prev === sortBy ? (order === 'asc' ? 'desc' : 'asc') : 'desc'
      )
      return sortBy
    })
  }, [])

  // 过滤和排序进程
  const filteredProcesses = (processes ?? [])
    .filter((p) => {
      if (!processFilter) return true
      const filterLower = processFilter.toLowerCase()
      return (
        p.name.toLowerCase().includes(filterLower) ||
        p.pid.toString().includes(filterLower)
      )
    })
    .sort((a, b) => {
      let comparison = 0
      switch (processSortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name)
          break
        case 'cpu':
          comparison = a.cpu - b.cpu
          break
        case 'memory':
          comparison = a.memoryBytes - b.memoryBytes
          break
        case 'pid':
          comparison = a.pid - b.pid
          break
      }
      return processSortOrder === 'asc' ? comparison : -comparison
    })

  // 结束进程
  const killProcess = useCallback(
    async (pid: number): Promise<boolean> => {
      try {
        await window.electronAPI.system.killProcess(pid)
        await refetchProcesses()
        return true
      } catch (err) {
        console.error('[useSystem] 结束进程失败:', err)
        return false
      }
    },
    [refetchProcesses]
  )

  // 自动刷新
  useEffect(() => {
    if (refreshTimerRef.current) {
      window.clearInterval(refreshTimerRef.current)
    }

    refreshTimerRef.current = window.setInterval(() => {
      refresh()
    }, refreshInterval)

    return () => {
      if (refreshTimerRef.current) {
        window.clearInterval(refreshTimerRef.current)
      }
    }
  }, [refreshInterval, refresh])

  const isLoading = isSystemLoading || isDisksLoading || isProcessesLoading

  return {
    systemInfo,
    disks,
    processes: filteredProcesses,
    isLoading,
    error: systemError,
    refreshInterval,
    processSortBy,
    processSortOrder,
    processFilter,
    refresh,
    setRefreshInterval,
    setProcessSorting,
    setProcessFilter,
    killProcess,
  }
}

export type UseSystemReturn = ReturnType<typeof useSystem>

/** 格式化字节大小 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`
}

/** 格式化运行时间 */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  const parts: string[] = []
  if (days > 0) parts.push(`${days}天`)
  if (hours > 0) parts.push(`${hours}小时`)
  if (minutes > 0) parts.push(`${minutes}分钟`)

  return parts.join(' ') || '刚刚启动'
}
