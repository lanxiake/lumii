/**
 * useAgentFiles — 管理 client_files 表中 Agent 生成文件的 React Hook
 *
 * 封装 files:list / files:search / files:delete IPC 调用，
 * 提供分页、搜索、过滤、乐观删除能力。
 */

import { useState, useEffect, useCallback, useRef } from 'react'

// ── 与 agent-runtime-commands 对齐的本地类型 ──

export interface AgentFile {
  readonly id: string
  readonly userId: string
  readonly agentId: string | null
  readonly conversationId: string | null
  readonly messageId: string | null
  readonly channel: string
  readonly sourceType: string
  readonly fileName: string
  readonly fileSize: number | null
  readonly mimeType: string | null
  readonly localPath: string
  readonly category: 'upload' | 'output'
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string | null
}

export interface AgentFilesFilter {
  agentId?: string
  channel?: string
  category?: 'upload' | 'output'
  conversationId?: string
  dateFrom?: string
  dateTo?: string
}

const PAGE_SIZE = 50

export interface UseAgentFilesReturn {
  files: AgentFile[]
  total: number
  loading: boolean
  error: string | null
  hasMore: boolean
  searchQuery: string
  filter: AgentFilesFilter
  setSearchQuery: (q: string) => void
  setFilter: (f: AgentFilesFilter) => void
  loadMore: () => void
  refresh: () => void
  deleteFiles: (ids: string[]) => Promise<void>
}

export function useAgentFiles(userId: string): UseAgentFilesReturn {
  const [files, setFiles] = useState<AgentFile[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQueryRaw] = useState('')
  const [filter, setFilterRaw] = useState<AgentFilesFilter>({})
  const [offset, setOffset] = useState(0)

  // 用于防止竞态：只取最后一次请求的结果
  const requestIdRef = useRef(0)

  const fetchFiles = useCallback(async (
    query: string,
    fil: AgentFilesFilter,
    currentOffset: number,
    append: boolean,
  ) => {
    if (!userId) return
    const reqId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    try {
      let result: { files: AgentFile[]; total: number }

      if (query.trim()) {
        // 搜索模式（API 返回数组，无 total）
        const hits = await window.electronAPI.agentRuntime.sendCommand({
          type: 'files:search',
          userId,
          query: query.trim(),
          filters: {
            agentId: fil.agentId,
            channel: fil.channel,
            conversationId: fil.conversationId,
          },
        }) as AgentFile[]
        result = { files: hits, total: hits.length }
      } else {
        // 列表模式（分页）
        const res = await window.electronAPI.agentRuntime.sendCommand({
          type: 'files:list',
          userId,
          agentId: fil.agentId,
          channel: fil.channel,
          category: fil.category,
          limit: PAGE_SIZE,
          offset: currentOffset,
        }) as { files: AgentFile[]; total: number }
        result = res
      }

      if (reqId !== requestIdRef.current) return // 已被更新的请求覆盖

      if (append) {
        setFiles((prev) => [...prev, ...result.files])
      } else {
        setFiles(result.files)
      }
      setTotal(result.total)
    } catch (err) {
      if (reqId !== requestIdRef.current) return
      setError(err instanceof Error ? err.message : '加载文件列表失败')
    } finally {
      if (reqId === requestIdRef.current) {
        setLoading(false)
      }
    }
  }, [userId])

  // 初始化 + query/filter 变化时重置并重新拉取
  useEffect(() => {
    setOffset(0)
    void fetchFiles(searchQuery, filter, 0, false)
  }, [searchQuery, filter, fetchFiles])

  const loadMore = useCallback(() => {
    if (loading || files.length >= total || searchQuery.trim()) return
    const newOffset = offset + PAGE_SIZE
    setOffset(newOffset)
    void fetchFiles(searchQuery, filter, newOffset, true)
  }, [loading, files.length, total, searchQuery, filter, offset, fetchFiles])

  const refresh = useCallback(() => {
    setOffset(0)
    void fetchFiles(searchQuery, filter, 0, false)
  }, [searchQuery, filter, fetchFiles])

  const setSearchQuery = useCallback((q: string) => {
    setSearchQueryRaw(q)
  }, [])

  const setFilter = useCallback((f: AgentFilesFilter) => {
    setFilterRaw(f)
  }, [])

  const deleteFiles = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    // 乐观更新：先从本地移除
    setFiles((prev) => prev.filter((f) => !ids.includes(f.id)))
    setTotal((prev) => Math.max(0, prev - ids.length))
    try {
      await window.electronAPI.agentRuntime.sendCommand({
        type: 'files:delete',
        fileIds: ids,
        userId,
      })
    } catch (err) {
      // 回滚：重新加载
      setError(err instanceof Error ? err.message : '删除失败')
      refresh()
    }
  }, [userId, refresh])

  return {
    files,
    total,
    loading,
    error,
    hasMore: !searchQuery.trim() && files.length < total,
    searchQuery,
    filter,
    setSearchQuery,
    setFilter,
    loadMore,
    refresh,
    deleteFiles,
  }
}
