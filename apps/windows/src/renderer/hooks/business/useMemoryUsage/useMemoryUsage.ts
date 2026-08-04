/**
 * useMemoryUsage — 通过 Agent Runtime IPC 管理本地 SQLite 中的 Agent 记忆
 *
 * 用于设置页「AI记忆」与轻量统计；记忆作用域由 sessionKey / agentId 解析。
 */

import { useCallback, useState } from 'react'

/** 单条记忆列表项（与 IPC agent:memories:list 对齐） */
export interface MemoryListItem {
  readonly id: string
  readonly category: string
  readonly content: string
  readonly importance: number
  readonly createdAt: number
  /** 来源段 ID（诉求 A：有值才可「查看来源」回溯原文） */
  readonly sourceSegmentId: string | null
  /** 对应的记忆宫殿语义片段（内容寻址 drawer_id），可空 */
  readonly palaceDrawerId: string | null
}

/** 记忆来源下转结果（与 IPC agent:memories:provenance 对齐） */
export interface MemoryProvenanceResult {
  readonly memoryId: string
  readonly sourceSegmentId: string | null
  readonly sourceMessageId: string | null
  readonly palaceDrawerId: string | null
  readonly originalText: string | null
  readonly segment: {
    readonly id: string
    readonly conversationId: string
    readonly startMessageId: string
    readonly endMessageId: string | null
    readonly createdAt: string
    readonly turnCount: number
    readonly charCount: number
  } | null
}

export interface UseMemoryUsageOptions {
  /** 当前对话 ID（与 sessionKey 一致），用于解析对话绑定的 Agent */
  readonly sessionKey?: string
  /** 直接指定 Agent 定义 ID；优先级低于从 session 解析的参与者 */
  readonly agentId?: string
}

/**
 * 记忆列表、删除、清空、导出（JSON）
 */
export function useMemoryUsage(options?: UseMemoryUsageOptions) {
  const { sessionKey, agentId } = options ?? {}
  const [loading, setLoading] = useState(false)

  const listMemories = useCallback(async (): Promise<readonly MemoryListItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    setLoading(true)
    try {
      const rows = (await api.sendCommand({
        type: 'agent:memories:list',
        sessionKey,
        agentId,
      })) as MemoryListItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    } finally {
      setLoading(false)
    }
  }, [sessionKey, agentId])

  const deleteMemory = useCallback(
    async (memoryId: string): Promise<boolean> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return false
      try {
        await api.sendCommand({ type: 'agent:memories:delete', memoryId })
        return true
      } catch {
        return false
      }
    },
    [],
  )

  const updateMemory = useCallback(
    async (memoryId: string, content: string): Promise<boolean> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return false
      try {
        await api.sendCommand({ type: 'agent:memories:update', memoryId, content })
        return true
      } catch {
        return false
      }
    },
    [],
  )

  const clearAll = useCallback(async (): Promise<number> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return 0
    try {
      const r = (await api.sendCommand({
        type: 'agent:memories:clear',
        sessionKey,
        agentId,
      })) as { deletedCount: number }
      return r?.deletedCount ?? 0
    } catch {
      return 0
    }
  }, [sessionKey, agentId])

  const exportJson = useCallback(async (): Promise<string> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return '[]'
    try {
      const r = (await api.sendCommand({
        type: 'agent:memories:export',
        sessionKey,
        agentId,
      })) as { json: string }
      return r?.json ?? '[]'
    } catch {
      return '[]'
    }
  }, [sessionKey, agentId])

  const getProvenance = useCallback(
    async (memoryId: string): Promise<MemoryProvenanceResult | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        const r = (await api.sendCommand({
          type: 'agent:memories:provenance',
          memoryId,
        })) as MemoryProvenanceResult | null
        return r ?? null
      } catch {
        return null
      }
    },
    [],
  )

  return { listMemories, deleteMemory, updateMemory, clearAll, exportJson, getProvenance, loading }
}
