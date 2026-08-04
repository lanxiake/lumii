/**
 * useAuditLog Hook - 审计日志管理
 *
 * 提供审计日志的查询、统计、导出和配置管理功能
 * 通过 API Server REST API 与后端交互
 */

import { useState, useCallback, useEffect } from 'react'
import type {
  AuditEventType,
  AuditSeverity,
  AuditSource,
  AuditLogEntry,
  AuditLogFilters,
  AuditLogQueryResult,
  AuditLogStats,
  AuditLogConfig,
} from './useAuditLog.types'

export interface UseAuditLogReturn {
  /** 日志条目列表 */
  entries: AuditLogEntry[]
  /** 总条目数 */
  total: number
  /** 统计信息 */
  stats: AuditLogStats | null
  /** 配置 */
  config: AuditLogConfig | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
  /** 当前筛选条件 */
  filters: AuditLogFilters

  /** 查询审计日志 */
  queryLogs: (filters?: AuditLogFilters) => Promise<void>
  /** 获取最近的日志 */
  getRecentLogs: (limit?: number) => Promise<AuditLogEntry[]>
  /** 获取统计信息 */
  getStats: () => Promise<void>
  /** 获取配置 */
  getConfig: () => Promise<void>
  /** 更新配置 */
  updateConfig: (config: Partial<AuditLogConfig>) => Promise<void>
  /** 导出日志 */
  exportLogs: (format: 'json' | 'csv', filters?: AuditLogFilters) => Promise<string>
  /** 清除日志 */
  clearLogs: (beforeDate?: string) => Promise<{ deletedCount: number }>
  /** 设置筛选条件 */
  setFilters: (filters: AuditLogFilters) => void
  /** 刷新日志 */
  refresh: () => Promise<void>
  /** 加载下一页 */
  loadMore: () => Promise<void>
}

/**
 * 审计日志 Hook
 */
export function useAuditLog(): UseAuditLogReturn {
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<AuditLogStats | null>(null)
  const [config, setConfig] = useState<AuditLogConfig | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<AuditLogFilters>({
    limit: 50,
    sortOrder: 'desc',
  })

  /**
   * 查询审计日志
   */
  const queryLogs = useCallback(async (newFilters?: AuditLogFilters) => {
    console.log('[useAuditLog] 查询审计日志', newFilters)
    setIsLoading(true)
    setError(null)

    const currentFilters = newFilters || filters
    if (newFilters) {
      setFilters(currentFilters)
    }

    try {
      const result = await window.electronAPI.api.queryAuditLogs(currentFilters) as {
        success: boolean
        data?: AuditLogQueryResult
        error?: string
      }

      if (result.success && result.data) {
        setEntries(result.data.entries)
        setTotal(result.data.total)
        console.log('[useAuditLog] 查询成功，共', result.data.total, '条记录')
      } else {
        console.error('[useAuditLog] 查询失败:', result.error)
        setError(result.error || '查询审计日志失败')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '查询审计日志失败'
      console.error('[useAuditLog] 查询失败:', errorMessage)
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }, [filters])

  /**
   * 获取最近的日志
   */
  const getRecentLogs = useCallback(async (limit: number = 20): Promise<AuditLogEntry[]> => {
    console.log('[useAuditLog] 获取最近日志', { limit })
    try {
      const result = await window.electronAPI.api.getRecentAuditLogs(limit) as {
        success: boolean
        data?: { entries: AuditLogEntry[]; total: number }
        error?: string
      }

      if (result.success && result.data) {
        return result.data.entries
      }
      return []
    } catch (err) {
      console.error('[useAuditLog] 获取最近日志失败:', err)
      return []
    }
  }, [])

  /**
   * 获取统计信息
   */
  const getStats = useCallback(async () => {
    console.log('[useAuditLog] 获取统计信息')
    try {
      const result = await window.electronAPI.api.getAuditStats() as {
        success: boolean
        data?: AuditLogStats
        error?: string
      }

      if (result.success && result.data) {
        setStats(result.data)
        console.log('[useAuditLog] 统计信息:', result.data)
      }
    } catch (err) {
      console.error('[useAuditLog] 获取统计失败:', err)
    }
  }, [])

  /**
   * 获取配置
   */
  const getConfig = useCallback(async () => {
    console.log('[useAuditLog] 获取配置')
    try {
      const result = await window.electronAPI.api.getAuditConfig() as {
        success: boolean
        data?: { config: AuditLogConfig }
        error?: string
      }

      if (result.success && result.data) {
        setConfig(result.data.config)
        console.log('[useAuditLog] 配置:', result.data.config)
      }
    } catch (err) {
      console.error('[useAuditLog] 获取配置失败:', err)
    }
  }, [])

  /**
   * 更新配置
   */
  const updateConfig = useCallback(async (newConfig: Partial<AuditLogConfig>) => {
    console.log('[useAuditLog] 更新配置', newConfig)
    try {
      const result = await window.electronAPI.api.updateAuditConfig(newConfig as Record<string, unknown>) as {
        success: boolean
        data?: { config: AuditLogConfig }
        error?: string
      }

      if (result.success && result.data) {
        setConfig(result.data.config)
        console.log('[useAuditLog] 配置已更新:', result.data.config)
      } else {
        throw new Error(result.error || '更新配置失败')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '更新配置失败'
      console.error('[useAuditLog] 更新配置失败:', errorMessage)
      throw new Error(errorMessage, { cause: err })
    }
  }, [])

  /**
   * 导出日志
   */
  const exportLogs = useCallback(async (format: 'json' | 'csv', exportFilters?: AuditLogFilters): Promise<string> => {
    console.log('[useAuditLog] 导出日志', { format, filters: exportFilters })
    try {
      const result = await window.electronAPI.api.exportAuditLogs({
        format,
        filters: (exportFilters || filters) as Record<string, unknown>,
      }) as {
        success: boolean
        data?: { content: string; format: string }
        error?: string
      }

      if (result.success && result.data) {
        return result.data.content
      }
      throw new Error(result.error || '导出失败')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '导出失败'
      console.error('[useAuditLog] 导出失败:', errorMessage)
      throw new Error(errorMessage, { cause: err })
    }
  }, [filters])

  /**
   * 清除日志
   */
  const clearLogs = useCallback(async (beforeDate?: string): Promise<{ deletedCount: number }> => {
    console.log('[useAuditLog] 清除日志', { beforeDate })
    try {
      const result = await window.electronAPI.api.clearAuditLogs(beforeDate) as {
        success: boolean
        data?: { deletedCount: number }
        error?: string
      }

      if (result.success && result.data) {
        // 刷新列表
        await queryLogs()
        await getStats()
        return result.data
      }
      throw new Error(result.error || '清除失败')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '清除失败'
      console.error('[useAuditLog] 清除失败:', errorMessage)
      throw new Error(errorMessage, { cause: err })
    }
  }, [queryLogs, getStats])

  /**
   * 刷新日志
   */
  const refresh = useCallback(async () => {
    console.log('[useAuditLog] 刷新日志')
    await Promise.all([
      queryLogs({ ...filters, offset: 0 }),
      getStats(),
    ])
  }, [filters, queryLogs, getStats])

  /**
   * 加载下一页
   */
  const loadMore = useCallback(async () => {
    const currentOffset = filters.offset || 0
    const currentLimit = filters.limit || 50
    const newOffset = currentOffset + currentLimit

    if (newOffset >= total) {
      console.log('[useAuditLog] 已加载全部')
      return
    }

    console.log('[useAuditLog] 加载下一页', { newOffset })
    setIsLoading(true)

    try {
      const result = await window.electronAPI.api.queryAuditLogs({
        ...filters,
        offset: newOffset,
      }) as {
        success: boolean
        data?: AuditLogQueryResult
        error?: string
      }

      if (result.success && result.data) {
        setEntries(prev => [...prev, ...result.data!.entries])
        setFilters(prev => ({ ...prev, offset: newOffset }))
      }
    } catch (err) {
      console.error('[useAuditLog] 加载更多失败:', err)
    } finally {
      setIsLoading(false)
    }
  }, [filters, total])

  /**
   * 初始化时加载配置
   */
  useEffect(() => {
    getConfig()
  }, [getConfig])

  return {
    // 状态
    entries,
    total,
    stats,
    config,
    isLoading,
    error,
    filters,

    // 方法
    queryLogs,
    getRecentLogs,
    getStats,
    getConfig,
    updateConfig,
    exportLogs,
    clearLogs,
    setFilters,
    refresh,
    loadMore,
  }
}
