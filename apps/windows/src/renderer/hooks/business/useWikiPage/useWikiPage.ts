/**
 * useWikiPage — 通过 Agent Runtime IPC 管理 Wiki 知识库（P0）
 *
 * 范式同 useMemoryUsage：window.electronAPI.agentRuntime.sendCommand 通用透传。
 */

import { useCallback, useState } from 'react'

export interface WikiInboxItem {
  readonly id: string
  readonly itemType: string
  readonly title: string
  readonly contentPreview: string | null
  readonly mediaType: string
  readonly status: string
  readonly attemptCount: number
  readonly lastError: string | null
  readonly createdAt: number
}

export interface WikiPageListItem {
  readonly id: string
  readonly path: string
  readonly category: string
  readonly title: string
  readonly version: number
  readonly updatedAt: number
}

export interface WikiPageDetail {
  readonly id: string
  readonly path: string
  readonly category: string
  readonly title: string
  readonly contentMd: string
  readonly version: number
  readonly updatedAt: number
}

export interface WikiSearchHit {
  readonly pageId: string
  readonly path: string
  readonly category: string
  readonly title: string
  readonly snippet: string
  readonly updatedAt: number
}

export interface WikiRunItem {
  readonly id: string
  readonly inboxIds: readonly string[]
  readonly status: string
  readonly resultSummary: string | null
  readonly error: string | null
  readonly createdAt: number
  readonly finishedAt: number | null
}

export function useWikiPage() {
  const [loading, setLoading] = useState(false)

  const listInbox = useCallback(async (status?: string): Promise<readonly WikiInboxItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    setLoading(true)
    try {
      const rows = (await api.sendCommand({ type: 'wiki:inbox:list', status })) as WikiInboxItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const retryInbox = useCallback(async (inboxId: string): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      const r = (await api.sendCommand({ type: 'wiki:inbox:retry', inboxId })) as { success: boolean }
      return !!r?.success
    } catch {
      return false
    }
  }, [])

  const discardInbox = useCallback(async (inboxId: string): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      const r = (await api.sendCommand({ type: 'wiki:inbox:discard', inboxId })) as { success: boolean }
      return !!r?.success
    } catch {
      return false
    }
  }, [])

  const organizeInbox = useCallback(
    async (inboxId: string, path: string, title?: string, contentMd?: string): Promise<string | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        const r = (await api.sendCommand({
          type: 'wiki:inbox:organize',
          inboxId,
          path,
          title,
          contentMd,
        })) as { pageId: string }
        return r?.pageId ?? null
      } catch {
        return null
      }
    },
    [],
  )

  const listPages = useCallback(async (category?: string): Promise<readonly WikiPageListItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    setLoading(true)
    try {
      const rows = (await api.sendCommand({ type: 'wiki:page:list', category })) as WikiPageListItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const getPage = useCallback(async (pageId: string): Promise<WikiPageDetail | null> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      const r = (await api.sendCommand({ type: 'wiki:page:get', pageId })) as WikiPageDetail | null
      return r ?? null
    } catch {
      return null
    }
  }, [])

  const updatePage = useCallback(
    async (path: string, title: string, contentMd: string): Promise<WikiPageDetail | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        const r = (await api.sendCommand({
          type: 'wiki:page:update',
          path,
          title,
          contentMd,
        })) as { pageId: string; version: number }
        if (!r?.pageId) return null
        return getPage(r.pageId)
      } catch {
        return null
      }
    },
    [getPage],
  )

  const deletePage = useCallback(async (pageId: string): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      const r = (await api.sendCommand({ type: 'wiki:page:delete', pageId })) as { success: boolean }
      return !!r?.success
    } catch {
      return false
    }
  }, [])

  const search = useCallback(async (keyword: string, limit?: number): Promise<readonly WikiSearchHit[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand || !keyword.trim()) return []
    setLoading(true)
    try {
      const rows = (await api.sendCommand({ type: 'wiki:search', keyword, limit })) as WikiSearchHit[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const listRuns = useCallback(async (limit?: number): Promise<readonly WikiRunItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    try {
      const rows = (await api.sendCommand({ type: 'wiki:runs:list', limit })) as WikiRunItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }, [])

  const rebuildIndex = useCallback(async (): Promise<number> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return 0
    try {
      const r = (await api.sendCommand({ type: 'wiki:index:rebuild' })) as { rebuiltCount: number }
      return r?.rebuiltCount ?? 0
    } catch {
      return 0
    }
  }, [])

  return {
    loading,
    listInbox,
    retryInbox,
    discardInbox,
    organizeInbox,
    listPages,
    getPage,
    updatePage,
    deletePage,
    search,
    listRuns,
    rebuildIndex,
  }
}
