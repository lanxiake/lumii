/**
 * useWikiPage — 通过 Agent Runtime IPC 管理 Wiki 知识库（P0）
 *
 * 范式同 useMemoryUsage：window.electronAPI.agentRuntime.sendCommand 通用透传。
 */

import { useCallback, useState } from 'react'

/** 单机应用固定单一 agent；主进程侧同样兜底 'assistant'（wiki-commands.ts resolveAgentIdForWiki） */
const DEFAULT_AGENT_ID = 'assistant'

export interface WikiInboxItem {
  readonly id: string
  readonly itemType: string
  readonly title: string
  readonly contentPreview: string | null
  readonly mediaType: string
  readonly status: string
  readonly attemptCount: number
  readonly lastError: string | null
  /** degraded = AI 拿不准留待人工整理，failed = 真的出错 */
  readonly lastOutcome: string | null
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
  readonly resultDetail: {
    readonly items: readonly {
      readonly inboxId: string
      readonly title: string
      readonly path: string
      readonly mediaType: string
      readonly outcome: string
      readonly reason?: string
      readonly extract: string
    }[]
  } | null
  readonly createdAt: number
  readonly finishedAt: number | null
}

export interface WikiBacklinkItem {
  readonly linkId: string
  readonly sourcePageId: string
  readonly sourceTitle: string
  readonly sourcePath: string
  readonly anchorText: string
  readonly isResolved: boolean
}

export interface WikiUnresolvedLinkItem {
  readonly id: string
  readonly sourcePageId: string
  readonly anchorText: string
  readonly createdAt: number
}

export interface WikiRevisionItem {
  readonly id: string
  readonly version: number
  readonly title: string
  readonly editor: string
  readonly sourceRef: string | null
  readonly createdAt: number
  readonly contentMd: string
}

export interface WikiCleanupSuggestionItem {
  readonly sourceId: string
  readonly title: string
  readonly reason: 'stale' | 'broken_source' | 'duplicate_content'
  readonly duplicateOfSourceId?: string
  /** 用途目录两列，只读展示；为空表示待补分 */
  readonly topicCategory?: string | null
  readonly topicSubtopic?: string | null
}

export interface WikiAttachmentItem {
  readonly id: string
  readonly pageId: string
  readonly sourceId: string | null
  readonly filePath: string
  readonly mediaType: string
  readonly displayName: string
  readonly createdAt: number
}

export interface WikiExportResultItem {
  readonly exported: number
  readonly failed: readonly { path: string; error: string }[]
}

export interface WikiConceptCandidateItem {
  readonly name: string
  readonly type: 'concept' | 'entity'
  readonly evidenceSourceIds: readonly string[]
  readonly suggestedContentMd: string
}

export interface WikiSynthesisListItem {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly sourcePageIds: readonly string[]
  readonly outputPath: string | null
  readonly error: string | null
  readonly progress: { chunk: number; total: number } | null
  readonly pageId: string | null
  readonly createdAt: number
  readonly finishedAt: number | null
}

export interface WikiSynthesisDetail extends WikiSynthesisListItem {
  readonly candidateMd: string
  readonly sourceIds: readonly string[] | null
  readonly sourcePages: readonly { id: string; title: string; path: string }[]
}

export interface WikiGraphDataItem {
  readonly nodes: readonly {
    readonly id: string
    readonly kind: 'page' | 'entity'
    readonly title: string
    readonly path?: string
    readonly category?: string
    readonly useCount?: number
    readonly entityType?: string
    readonly pageId?: string | null
  }[]
  readonly edges: readonly {
    readonly id: string
    readonly kind: 'wikilink' | 'relation'
    readonly source: string
    readonly target: string
    readonly label: string
    readonly anchorText?: string
    readonly strength?: number
  }[]
  readonly truncated: boolean
}

/** ERO 实体观察摘要（侧栏只读展示） */
export interface WikiObservationItem {
  readonly id: string
  readonly entityId: string
  readonly content: string
  readonly sourcePageId: string | null
  readonly createdAt: string
}

export interface WikiStatusCandidateItem {
  readonly pageId: string
  readonly title: string
  readonly path: string
  readonly suggestedStatus: string
  readonly reason: string
}

export interface WikiTopicTree {
  readonly version: 1
  readonly categories: ReadonlyArray<{ readonly name: string; readonly subtopics: readonly string[] }>
}

/** 删除主题节点时的文件去向 */
export type WikiFileDisposition =
  | { readonly type: 'parking' }
  | { readonly type: 'move'; readonly category: string; readonly subtopic: string }

/** 主题树九种变更操作（与 runtime 侧 WikiTopicMutation 同形） */
export type WikiTopicMutation =
  | { readonly op: 'addCategory'; readonly name: string; readonly index?: number }
  | { readonly op: 'renameCategory'; readonly from: string; readonly to: string }
  | { readonly op: 'deleteCategory'; readonly name: string; readonly disposition?: WikiFileDisposition }
  | { readonly op: 'reorderCategories'; readonly names: readonly string[] }
  | { readonly op: 'addSubtopic'; readonly category: string; readonly name: string; readonly index?: number }
  | { readonly op: 'renameSubtopic'; readonly category: string; readonly from: string; readonly to: string }
  | { readonly op: 'deleteSubtopic'; readonly category: string; readonly name: string; readonly disposition?: WikiFileDisposition }
  | { readonly op: 'moveSubtopic'; readonly fromCategory: string; readonly name: string; readonly toCategory: string; readonly index?: number }
  | { readonly op: 'mergeSubtopic'; readonly fromCategory: string; readonly fromName: string; readonly toCategory: string; readonly toName: string }

export type WikiTopicMutateResult =
  | { readonly ok: true; readonly tree: WikiTopicTree; readonly movedCount: number }
  | { readonly ok: false; readonly error: string }

export interface WikiSourceListItem {
  readonly id: string
  readonly title: string
  readonly sourcePath: string | null
  readonly mediaType: string
  readonly topicCategory: string | null
  readonly topicSubtopic: string | null
  readonly updatedAt: number
  readonly useCount: number
}

export interface WikiSourceSearchHit {
  readonly sourceId: string
  readonly title: string
  readonly category: string | null
  readonly subtopic: string | null
  readonly snippet: string
  readonly mediaType: string
  readonly sourcePath: string | null
  readonly updatedAt: number
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

  /** 返回收件箱条数（角标用，不受 list LIMIT 影响） */
  const countInbox = useCallback(async (status?: string): Promise<number> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return 0
    try {
      const r = (await api.sendCommand({
        type: 'wiki:inbox:count',
        status: status as 'pending' | 'organized' | 'discarded' | undefined,
      })) as { total: number }
      return typeof r?.total === 'number' ? r.total : 0
    } catch {
      return 0
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

  /** 手动指定用途大类/小类立即归档；不允许归到临时存放（那是文件列表里的显式操作）。 */
  const organizeInbox = useCallback(
    async (
      inboxId: string,
      category: string,
      subtopic: string,
      title?: string,
    ): Promise<{ sourceId: string; category: string; subtopic: string } | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        return (await api.sendCommand({
          type: 'wiki:inbox:organize',
          inboxId,
          category,
          subtopic,
          title,
        })) as { sourceId: string; category: string; subtopic: string }
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

  const listBacklinks = useCallback(async (pageId: string): Promise<readonly WikiBacklinkItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    try {
      const rows = (await api.sendCommand({ type: 'wiki:link:backlinks', pageId })) as WikiBacklinkItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }, [])

  const listUnresolvedLinks = useCallback(async (): Promise<readonly WikiUnresolvedLinkItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    try {
      const rows = (await api.sendCommand({ type: 'wiki:link:unresolved' })) as WikiUnresolvedLinkItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }, [])

  const listRevisions = useCallback(async (pageId: string): Promise<readonly WikiRevisionItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    try {
      const rows = (await api.sendCommand({ type: 'wiki:page:revisions', pageId })) as WikiRevisionItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }, [])

  const rollbackPage = useCallback(
    async (pageId: string, targetVersion: number): Promise<WikiPageDetail | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        const r = (await api.sendCommand({
          type: 'wiki:page:rollback',
          pageId,
          targetVersion,
        })) as { pageId: string }
        if (!r?.pageId) return null
        return getPage(r.pageId)
      } catch {
        return null
      }
    },
    [getPage],
  )

  const cleanupScan = useCallback(async (staleDays?: number): Promise<readonly WikiCleanupSuggestionItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    setLoading(true)
    try {
      const rows = (await api.sendCommand({
        type: 'wiki:cleanup:scan',
        staleDays,
      })) as WikiCleanupSuggestionItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const archiveSources = useCallback(async (sourceIds: readonly string[]): Promise<number> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return 0
    try {
      const r = (await api.sendCommand({ type: 'wiki:source:archive', sourceIds })) as { archived: number }
      return r?.archived ?? 0
    } catch {
      return 0
    }
  }, [])

  const restoreSources = useCallback(async (sourceIds: readonly string[]): Promise<number> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return 0
    try {
      const r = (await api.sendCommand({ type: 'wiki:source:restore', sourceIds })) as { restored: number }
      return r?.restored ?? 0
    } catch {
      return 0
    }
  }, [])

  const deleteSources = useCallback(async (sourceIds: readonly string[]): Promise<number> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return 0
    try {
      const r = (await api.sendCommand({ type: 'wiki:source:delete', sourceIds })) as { deleted: number }
      return r?.deleted ?? 0
    } catch {
      return 0
    }
  }, [])

  const listAttachments = useCallback(async (pageId: string): Promise<readonly WikiAttachmentItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    try {
      const rows = (await api.sendCommand({ type: 'wiki:attach:list', pageId })) as WikiAttachmentItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }, [])

  const addAttachment = useCallback(
    async (
      pageId: string,
      filePath: string,
      mediaType: 'document' | 'image' | 'audio' | 'video',
      displayName: string,
      sourceId?: string,
    ): Promise<WikiAttachmentItem | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        const r = (await api.sendCommand({
          type: 'wiki:attach:add',
          pageId,
          filePath,
          mediaType,
          displayName,
          sourceId,
        })) as WikiAttachmentItem
        return r ?? null
      } catch {
        return null
      }
    },
    [],
  )

  const removeAttachment = useCallback(async (attachmentId: string): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      const r = (await api.sendCommand({ type: 'wiki:attach:remove', attachmentId })) as { success: boolean }
      return !!r?.success
    } catch {
      return false
    }
  }, [])

  const exportPages = useCallback(
    async (
      targetDir: string,
      options?: { includeSources?: boolean; includeAttachments?: boolean },
    ): Promise<WikiExportResultItem | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      setLoading(true)
      try {
        const r = (await api.sendCommand({
          type: 'wiki:export',
          targetDir,
          includeSources: options?.includeSources,
          includeAttachments: options?.includeAttachments,
        })) as WikiExportResultItem
        return r ?? null
      } catch {
        return null
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  const conceptScan = useCallback(async (limit?: number): Promise<readonly WikiConceptCandidateItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    setLoading(true)
    try {
      const rows = (await api.sendCommand({ type: 'wiki:concept:scan', limit })) as WikiConceptCandidateItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const confirmConcept = useCallback(
    async (name: string, conceptType: 'concept' | 'entity'): Promise<string | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        const r = (await api.sendCommand({
          type: 'wiki:concept:confirm',
          name,
          conceptType,
        })) as { pageId: string }
        return r?.pageId ?? null
      } catch {
        return null
      }
    },
    [],
  )

  const rejectConcept = useCallback(async (name: string, conceptType: 'concept' | 'entity'): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      const r = (await api.sendCommand({ type: 'wiki:concept:reject', name, conceptType })) as { success: boolean }
      return !!r?.success
    } catch {
      return false
    }
  }, [])

  const createSynthesis = useCallback(
    async (params: {
      pageIds?: readonly string[]
      category?: string
      title?: string
    }): Promise<string | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      setLoading(true)
      try {
        const r = (await api.sendCommand({
          type: 'wiki:synthesis:create',
          pageIds: params.pageIds,
          category: params.category,
          title: params.title,
        })) as { synthesisId: string }
        return r?.synthesisId ?? null
      } catch {
        return null
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  const listSyntheses = useCallback(
    async (status?: 'candidate' | 'accepted' | 'rejected'): Promise<readonly WikiSynthesisListItem[]> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return []
      try {
        const rows = (await api.sendCommand({ type: 'wiki:synthesis:list', status })) as WikiSynthesisListItem[]
        return Array.isArray(rows) ? rows : []
      } catch {
        return []
      }
    },
    [],
  )

  const getSynthesis = useCallback(async (synthesisId: string): Promise<WikiSynthesisDetail | null> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      return (await api.sendCommand({ type: 'wiki:synthesis:get', synthesisId })) as WikiSynthesisDetail
    } catch {
      return null
    }
  }, [])

  const acceptSynthesis = useCallback(async (synthesisId: string): Promise<string | null> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      const r = (await api.sendCommand({ type: 'wiki:synthesis:accept', synthesisId })) as { pageId: string }
      return r?.pageId ?? null
    } catch {
      return null
    }
  }, [])

  const rejectSynthesis = useCallback(async (synthesisId: string): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      const r = (await api.sendCommand({ type: 'wiki:synthesis:reject', synthesisId })) as { success: boolean }
      return !!r?.success
    } catch {
      return false
    }
  }, [])

  /**
   * 一键自动综述：串行生成 sources/media 稳定 overview 页。
   */
  const autoRunSynthesis = useCallback(async () => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      return (await api.sendCommand({ type: 'wiki:synthesis:auto-run' })) as {
        results: readonly {
          category: string
          pageId: string
          path: string
          skipped?: boolean
          error?: string
        }[]
      }
    } catch {
      return null
    }
  }, [])

  const searchHybrid = useCallback(
    async (
      keyword: string,
      options?: { limit?: number; enableVector?: boolean },
    ): Promise<{
      hits: readonly WikiSearchHit[]
      degradeReason: string | null
      mode: string
    } | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        const r = (await api.sendCommand({
          type: 'wiki:search:hybrid',
          keyword,
          limit: options?.limit,
          enableVector: options?.enableVector,
        })) as {
          hits: readonly WikiSearchHit[]
          degradeReason: string | null
          mode: string
          backend?: string
        }
        return r
      } catch {
        return null
      }
    },
    [],
  )

  const bootstrapEro = useCallback(async (): Promise<{ entities: number; relations: number } | null> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      return (await api.sendCommand({ type: 'wiki:ero:bootstrap' })) as {
        entities: number
        relations: number
      }
    } catch {
      return null
    }
  }, [])

  /**
   * AI 抽取最近更新页的实体关系观察。
   */
  const extractEro = useCallback(async (): Promise<{
    pagesProcessed: number
    entitiesUpserted: number
    relationsUpserted: number
    observationsAdded: number
    errors: readonly string[]
  } | null> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      return (await api.sendCommand({ type: 'wiki:ero:extract' })) as {
        pagesProcessed: number
        entitiesUpserted: number
        relationsUpserted: number
        observationsAdded: number
        errors: readonly string[]
      }
    } catch {
      return null
    }
  }, [])

  /**
   * 加载指定实体的活跃观察摘要（wiki:ero:list + entityId）。
   */
  const listEntityObservations = useCallback(
    async (entityId: string): Promise<readonly WikiObservationItem[]> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand || !entityId) return []
      try {
        const r = (await api.sendCommand({
          type: 'wiki:ero:list',
          entityId,
        })) as {
          observations?: readonly {
            id: string
            entity_id: string
            content: string
            source_page_id: string | null
            created_at: string
          }[]
        }
        const rows = r?.observations
        if (!Array.isArray(rows)) return []
        return rows.map((o) => ({
          id: o.id,
          entityId: o.entity_id,
          content: o.content,
          sourcePageId: o.source_page_id,
          createdAt: o.created_at,
        }))
      } catch {
        return []
      }
    },
    [],
  )

  const getGraphData = useCallback(
    async (params: {
      centerPageId?: string
      category?: string
      limit?: number
    }): Promise<WikiGraphDataItem | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        return (await api.sendCommand({
          type: 'wiki:graph:data',
          centerPageId: params.centerPageId,
          category: params.category,
          limit: params.limit,
        })) as WikiGraphDataItem
      } catch {
        return null
      }
    },
    [],
  )

  const statusScan = useCallback(async (staleDays?: number): Promise<readonly WikiStatusCandidateItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    try {
      const rows = (await api.sendCommand({ type: 'wiki:status:scan', staleDays })) as WikiStatusCandidateItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }, [])

  const confirmStatus = useCallback(
    async (
      pageId: string,
      action: 'confirm' | 'reject',
      status?: 'outdated' | 'doubtful' | 'archived',
    ): Promise<boolean> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return false
      try {
        const r = (await api.sendCommand({
          type: 'wiki:status:confirm',
          pageId,
          action,
          status,
        })) as { success: boolean }
        return !!r?.success
      } catch {
        return false
      }
    },
    [],
  )

  const loadTopicTree = useCallback(async (): Promise<WikiTopicTree | null> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      const r = (await api.sendCommand({
        type: 'wiki:topic:tree:get',
        agentId: DEFAULT_AGENT_ID,
      })) as { tree: WikiTopicTree }
      return r?.tree ?? null
    } catch {
      return null
    }
  }, [])

  const setTopicTree = useCallback(async (tree: WikiTopicTree): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      const r = (await api.sendCommand({
        type: 'wiki:topic:tree:set',
        agentId: DEFAULT_AGENT_ID,
        tree,
      })) as { success: boolean }
      return !!r?.success
    } catch {
      return false
    }
  }, [])

  /**
   * 应用一次主题树变更。与其它封装不同，这里要把后端中文错误交给编辑器行内显示，
   * 所以不吞异常，而是返回带 error 的结果对象。
   */
  const mutateTopic = useCallback(
    async (mutation: WikiTopicMutation): Promise<WikiTopicMutateResult> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return { ok: false, error: '运行时不可用' }
      try {
        const r = (await api.sendCommand({
          type: 'wiki:topic:mutate',
          agentId: DEFAULT_AGENT_ID,
          mutation,
        })) as { tree: WikiTopicTree; movedCount: number }
        return { ok: true, tree: r.tree, movedCount: r.movedCount ?? 0 }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '操作失败' }
      }
    },
    [],
  )

  const listSources = useCallback(
    async (filter?: {
      category?: string
      subtopic?: string
      parking?: boolean
      unfiled?: boolean
      mediaType?: string
    }): Promise<readonly WikiSourceListItem[]> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return []
      setLoading(true)
      try {
        const r = (await api.sendCommand({
          type: 'wiki:source:list',
          agentId: DEFAULT_AGENT_ID,
          category: filter?.category,
          subtopic: filter?.subtopic,
          parking: filter?.parking,
          unfiled: filter?.unfiled,
          mediaType: filter?.mediaType,
        })) as { sources: WikiSourceListItem[] }
        return Array.isArray(r?.sources) ? r.sources : []
      } catch {
        return []
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  const updateSourceTopic = useCallback(
    async (sourceId: string, category: string, subtopic: string | null): Promise<boolean> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return false
      try {
        const r = (await api.sendCommand({
          type: 'wiki:source:update-topic',
          agentId: DEFAULT_AGENT_ID,
          sourceId,
          category,
          subtopic,
        })) as { id: string }
        return !!r?.id
      } catch {
        return false
      }
    },
    [],
  )

  const moveToParking = useCallback(async (sourceId: string): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      const r = (await api.sendCommand({
        type: 'wiki:source:move-to-parking',
        agentId: DEFAULT_AGENT_ID,
        sourceId,
      })) as { id: string }
      return !!r?.id
    } catch {
      return false
    }
  }, [])

  /** 失败把 error 抛给调用方，让 UI 展示「无法打开原文件」等具体原因 */
  const openSource = useCallback(async (sourceId: string): Promise<void> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) throw new Error('agentRuntime 不可用')
    await api.sendCommand({ type: 'wiki:source:open', agentId: DEFAULT_AGENT_ID, sourceId })
  }, [])

  const searchSources = useCallback(async (keyword: string, limit?: number): Promise<readonly WikiSourceSearchHit[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand || !keyword.trim()) return []
    setLoading(true)
    try {
      const rows = (await api.sendCommand({
        type: 'wiki:search',
        agentId: DEFAULT_AGENT_ID,
        keyword,
        limit,
      })) as WikiSourceSearchHit[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  return {
    loading,
    listInbox,
    countInbox,
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
    listBacklinks,
    listUnresolvedLinks,
    listRevisions,
    rollbackPage,
    cleanupScan,
    archiveSources,
    restoreSources,
    deleteSources,
    listAttachments,
    addAttachment,
    removeAttachment,
    exportPages,
    conceptScan,
    confirmConcept,
    rejectConcept,
    createSynthesis,
    listSyntheses,
    getSynthesis,
    acceptSynthesis,
    rejectSynthesis,
    autoRunSynthesis,
    getGraphData,
    statusScan,
    confirmStatus,
    searchHybrid,
    bootstrapEro,
    extractEro,
    listEntityObservations,
    loadTopicTree,
    setTopicTree,
    mutateTopic,
    listSources,
    updateSourceTopic,
    moveToParking,
    openSource,
    searchSources,
  }
}
