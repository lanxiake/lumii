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
  readonly sourcePath: string | null
  readonly sourceUrl: string | null
  readonly contentPreview: string | null
  readonly mediaType: string
  readonly status: string
  readonly attemptCount: number
  readonly lastError: string | null
  /** degraded = AI 拿不准留待人工整理，failed = 真的出错 */
  readonly lastOutcome: string | null
  readonly createdAt: number
}

/** 文件夹导入 scan 单条候选 */
export interface WikiFolderCandidateItem {
  readonly path: string
  readonly title: string
  readonly size: number
  readonly itemType: string
  readonly skipReason: string | null
  readonly alreadyInWiki: boolean
}

/** 文件夹 scan 结果 */
export interface WikiFolderScanResult {
  readonly dir: string
  readonly candidates: readonly WikiFolderCandidateItem[]
  readonly summary: {
    readonly total: number
    readonly importable: number
    readonly skipped: number
    readonly alreadyInWiki: number
  }
  readonly directoryTree?: string
  readonly topicOccupancy?: string
  readonly navSectionGuide?: string
}

/** 文件夹 import 结果 */
export interface WikiFolderImportResult {
  readonly dir: string
  readonly dryRun: boolean
  readonly imported: number
  readonly skipped: number
  readonly inboxIds: readonly string[]
  readonly autoClassify?: boolean
  readonly organizeRun?: {
    readonly runId: string
    readonly status: string
    readonly summary: string | null
  } | null
}

/** 资料详情（wiki:source:get） */
export interface WikiSourceDetail {
  readonly id: string
  readonly title: string
  readonly sourcePath: string | null
  readonly sourceUrl: string | null
  readonly mediaType: string
  readonly mimeType: string | null
  readonly extractedText: string | null
  readonly originContext: string | null
  readonly topicCategory: string | null
  readonly topicSubtopic: string | null
  readonly createdAt: number
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

export interface WikiCleanupSuggestionItem {
  readonly sourceId: string
  readonly title: string
  readonly reason: 'stale' | 'broken_source' | 'duplicate_content'
  readonly duplicateOfSourceId?: string
  /** 用途目录两列，只读展示；为空表示待补分 */
  readonly topicCategory?: string | null
  readonly topicSubtopic?: string | null
  /** 推荐给用户的默认动作（二期 §12）*/
  readonly suggestedAction?: 'parking' | 'delete'
}

export interface WikiExportResultItem {
  readonly exported: number
  readonly failed: readonly { path: string; error: string }[]
}

export interface WikiGraphDataItem {
  readonly nodes: readonly {
    readonly id: string
    readonly kind: 'entity' | 'category' | 'subtopic' | 'source'
    readonly title: string
    readonly path?: string
    readonly category?: string
    readonly useCount?: number
    readonly entityType?: string
    readonly pageId?: string | null
    readonly topicCategory?: string | null
    readonly topicSubtopic?: string | null
  }[]
  readonly edges: readonly {
    readonly id: string
    readonly kind: 'relation' | 'belongs_to' | 'sibling' | 'mentioned_in'
    readonly source: string
    readonly target: string
    readonly label: string
    readonly anchorText?: string
    readonly strength?: number
  }[]
  readonly truncated: boolean
}

/** 三期：实体出现的资料引用 */
export interface WikiEntitySourceRef {
  readonly id: string
  readonly title: string
  readonly sourcePath: string | null
  readonly topicCategory: string | null
  readonly topicSubtopic: string | null
  readonly mediaType: string
}

/** 三期：wiki:ero:extract target='sources' 结果 */
export interface WikiEroExtractSourceResult {
  readonly sourcesScanned?: number
  readonly sourcesSkipped?: number
  readonly sourcesFailed?: number
  readonly entitiesUpserted: number
  readonly relationsUpserted: number
  readonly observationsAdded: number
  readonly errors: readonly (string | { sourceId: string; title: string; message: string })[]
}

/** 三期：图层枚举 */
export type WikiGraphLayer = 'structure' | 'entities'

/** 三期：图谱查询参数 */
export interface WikiGraphQuery {
  readonly category?: string
  readonly subtopic?: string
  readonly limit?: number
  readonly layers?: readonly WikiGraphLayer[]
}

/** ERO 实体观察摘要（侧栏只读展示） */
export interface WikiObservationItem {
  readonly id: string
  readonly entityId: string
  readonly content: string
  readonly sourcePageId: string | null
  readonly createdAt: string
}

export interface WikiTopicTree {
  readonly version: 1 | 2
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

/** 重新编目范围 */
export type WikiReclassifyScopeDto =
  | { readonly kind: 'source'; readonly sourceId: string }
  | { readonly kind: 'subtopic'; readonly category: string; readonly subtopic: string | null }
  | { readonly kind: 'all' }

export interface WikiReclassifyCandidateItem {
  readonly id: string
  readonly sourceId: string
  readonly title: string
  readonly fromCategory: string | null
  readonly fromSubtopic: string | null
  readonly toCategory: string
  readonly toSubtopic: string | null
  readonly reason: string
  readonly decidedBy: 'structure' | 'content'
  readonly renameTitle?: string
  readonly applyError?: string
}

export interface WikiReclassifyRunItem {
  readonly runId: string
  readonly status: 'running' | 'review' | 'applying' | 'failed' | 'discarded'
  readonly total: number
  readonly processed: number
  readonly droppedInvalid: number
  readonly unchanged: number
  readonly error: string | null
  readonly candidates: readonly WikiReclassifyCandidateItem[]
}

export interface WikiReclassifyEstimateItem {
  readonly fileCount: number
  readonly structureCalls: number
  readonly estimatedContentCalls: number
  readonly inboxCount?: number
  readonly note: string
}

export interface WikiSourceListItem {
  readonly id: string
  readonly title: string
  readonly sourcePath: string | null
  readonly mediaType: string
  readonly topicCategory: string | null
  readonly topicSubtopic: string | null
  /** extracted_text 字符数，用于识别短文碎片 */
  readonly textLength: number
  readonly updatedAt: number
  readonly useCount: number
  readonly summary?: string | null
  /** 无摘要时的兜底副标题：正文前 60 字 */
  readonly extractedTextPreview?: string | null
}

export type SearchMode = 'fts' | 'vector' | 'hybrid'

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
      const rows = (await api.sendCommand({
        type: 'wiki:inbox:list',
        agentId: DEFAULT_AGENT_ID,
        status,
      })) as WikiInboxItem[]
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
        agentId: DEFAULT_AGENT_ID,
        status: status as 'pending' | 'organized' | 'discarded' | undefined,
      })) as { total: number; pending: number; unfiled: number }
      if (status) {
        return typeof r?.pending === 'number' ? r.pending : 0
      }
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
      /** null = 只归大类、暂不细分（小类可选） */
      subtopic: string | null,
      title?: string,
    ): Promise<{ sourceId: string; category: string; subtopic: string | null } | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        return (await api.sendCommand({
          type: 'wiki:inbox:organize',
          inboxId,
          category,
          subtopic,
          title,
        })) as { sourceId: string; category: string; subtopic: string | null }
      } catch {
        return null
      }
    },
    [],
  )

  /**
   * 预览目录内可导入 Wiki 的文件（不写库）。
   */
  const scanFolder = useCallback(async (dir: string, recursive = true): Promise<WikiFolderScanResult | null> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      return (await api.sendCommand({
        type: 'wiki:folder:scan',
        agentId: DEFAULT_AGENT_ID,
        dir,
        recursive,
      })) as WikiFolderScanResult
    } catch {
      return null
    }
  }, [])

  /**
   * 批量将目录文件摄入 Wiki 收件箱。
   */
  const importFolder = useCallback(
    async (
      dir: string,
      options?: { recursive?: boolean; dryRun?: boolean; autoClassify?: boolean },
    ): Promise<WikiFolderImportResult | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        return (await api.sendCommand({
          type: 'wiki:folder:import',
          agentId: DEFAULT_AGENT_ID,
          dir,
          recursive: options?.recursive ?? true,
          dryRun: options?.dryRun,
          ...(options?.autoClassify === false ? { autoClassify: false } : {}),
        })) as WikiFolderImportResult
      } catch {
        return null
      }
    },
    [],
  )

  /**
   * 读取 Wiki「新资料 AI 自动分类」开关（默认关闭）。
   */
  const loadAutoClassifySetting = useCallback(async (): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      const r = (await api.sendCommand({
        type: 'wiki:auto-classify:get',
        agentId: DEFAULT_AGENT_ID,
      })) as { enabled: boolean }
      return r?.enabled === true
    } catch {
      return false
    }
  }, [])

  /**
   * 保存 Wiki「新资料 AI 自动分类」开关。
   */
  const setAutoClassifyEnabled = useCallback(async (enabled: boolean): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      await api.sendCommand({
        type: 'wiki:auto-classify:set',
        agentId: DEFAULT_AGENT_ID,
        enabled,
      })
      return true
    } catch {
      return false
    }
  }, [])

  /**
   * 显式触发一批 Wiki intake（加速落库为未分类资料）。
   */
  const runOrganize = useCallback(
    async (options?: {
      mode?: 'intake' | 'organize' | 'organize-all'
      itemType?: string
      inboxIds?: readonly string[]
      sourceIds?: readonly string[]
    }): Promise<{
      runId: string | null
      status: string
      summary: string | null
    } | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        return (await api.sendCommand({
          type: 'wiki:organize:run',
          agentId: DEFAULT_AGENT_ID,
          mode: options?.mode ?? 'intake',
          itemType: (options?.itemType as 'upload' | 'output' | 'search' | 'chat') ?? 'output',
          inboxIds: options?.inboxIds,
          sourceIds: options?.sourceIds,
        })) as { runId: string | null; status: string; summary: string | null }
      } catch {
        return null
      }
    },
    [],
  )

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

  const exportSources = useCallback(
    async (targetDir: string): Promise<WikiExportResultItem | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      setLoading(true)
      try {
        const r = (await api.sendCommand({
          type: 'wiki:export',
          targetDir,
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

  /**
   * 三期：图谱数据查询，支持三层架构与小类范围。
   */
  const getGraphData = useCallback(async (query: WikiGraphQuery): Promise<WikiGraphDataItem | null> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      return (await api.sendCommand({
        type: 'wiki:graph:data',
        category: query.category,
        subtopic: query.subtopic,
        limit: query.limit,
        layers: query.layers as ('structure' | 'entities')[] | undefined,
      })) as WikiGraphDataItem
    } catch {
      return null
    }
  }, [])

  /**
   * 三期：按资料范围（小类/大类/sourceIds）抽取实体关系，写 source_id，增量跳过。
   */
  const extractEroFromSources = useCallback(
    async (scope: {
      category?: string
      subtopic?: string
      sourceIds?: readonly string[]
    }): Promise<WikiEroExtractSourceResult | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        return (await api.sendCommand({
          type: 'wiki:ero:extract',
          target: 'sources',
          category: scope.category,
          subtopic: scope.subtopic,
          sourceIds: scope.sourceIds,
        })) as WikiEroExtractSourceResult
      } catch {
        return null
      }
    },
    [],
  )

  /**
   * 三期：实体出现于哪些资料（实体侧栏）。
   */
  const listEntitySources = useCallback(async (entityId: string): Promise<readonly WikiEntitySourceRef[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand || !entityId) return []
    try {
      const r = (await api.sendCommand({
        type: 'wiki:ero:entity-sources',
        entityId,
      })) as { sources: readonly WikiEntitySourceRef[] }
      return Array.isArray(r.sources) ? r.sources : []
    } catch {
      return []
    }
  }, [])

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

  /** 在某个正式目录下新建 markdown 笔记，返回新资料 id */
  const createNote = useCallback(
    async (
      category: string,
      /** null = 「暂不细分」分组（小类可选） */
      subtopic: string | null,
      title?: string,
    ): Promise<{ sourceId: string; title: string } | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        const r = (await api.sendCommand({
          type: 'wiki:source:create-note',
          agentId: DEFAULT_AGENT_ID,
          category,
          subtopic,
          title,
        })) as { sourceId: string; title: string }
        return r ?? null
      } catch {
        return null
      }
    },
    [],
  )

  const renameSource = useCallback(async (sourceId: string, title: string): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      await api.sendCommand({
        type: 'wiki:source:rename',
        agentId: DEFAULT_AGENT_ID,
        sourceId,
        title,
      })
      return true
    } catch {
      return false
    }
  }, [])

  /**
   * 启动重新编目。状态冲突（已有批次）要让用户看到，所以返回结果对象而非布尔。
   */
  const runReclassify = useCallback(
    async (
      scope: WikiReclassifyScopeDto,
      opts?: { force?: boolean; enableRename?: boolean },
    ): Promise<{ ok: true; runId: string } | { ok: false; error: string }> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return { ok: false, error: '运行时不可用' }
      try {
        const r = (await api.sendCommand({
          type: 'wiki:reclassify:run',
          agentId: DEFAULT_AGENT_ID,
          scope: scope.kind,
          sourceId: scope.kind === 'source' ? scope.sourceId : undefined,
          category: scope.kind === 'subtopic' ? scope.category : undefined,
          subtopic: scope.kind === 'subtopic' ? scope.subtopic : undefined,
          force: opts?.force,
          enableRename: opts?.enableRename,
        })) as { runId: string }
        return { ok: true, runId: r.runId }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '重新编目启动失败' }
      }
    },
    [],
  )

  /** 预估某次编目将调用多少次模型，供确认弹窗展示。 */
  const estimateReclassify = useCallback(
    async (scope: WikiReclassifyScopeDto): Promise<WikiReclassifyEstimateItem | null> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return null
      try {
        return (await api.sendCommand({
          type: 'wiki:reclassify:estimate',
          agentId: DEFAULT_AGENT_ID,
          scope: scope.kind,
          sourceId: scope.kind === 'source' ? scope.sourceId : undefined,
          category: scope.kind === 'subtopic' ? scope.category : undefined,
          subtopic: scope.kind === 'subtopic' ? scope.subtopic : undefined,
        })) as WikiReclassifyEstimateItem
      } catch {
        return null
      }
    },
    [],
  )

  const getReclassifyRun = useCallback(async (): Promise<WikiReclassifyRunItem | null> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      const r = (await api.sendCommand({
        type: 'wiki:reclassify:get',
        agentId: DEFAULT_AGENT_ID,
      })) as { run: WikiReclassifyRunItem | null }
      return r?.run ?? null
    } catch {
      return null
    }
  }, [])

  const applyReclassify = useCallback(
    async (candidateIds: readonly string[]): Promise<{ applied: number; failed: number }> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return { applied: 0, failed: 0 }
      try {
        return (await api.sendCommand({
          type: 'wiki:reclassify:apply',
          agentId: DEFAULT_AGENT_ID,
          candidateIds,
        })) as { applied: number; failed: number }
      } catch {
        return { applied: 0, failed: 0 }
      }
    },
    [],
  )

  const ignoreReclassify = useCallback(async (candidateId: string): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      await api.sendCommand({
        type: 'wiki:reclassify:ignore',
        agentId: DEFAULT_AGENT_ID,
        candidateId,
      })
      return true
    } catch {
      return false
    }
  }, [])

  const discardReclassify = useCallback(async (): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    try {
      await api.sendCommand({ type: 'wiki:reclassify:discard', agentId: DEFAULT_AGENT_ID })
      return true
    } catch {
      return false
    }
  }, [])

  const listSources = useCallback(
    async (filter?: {
      category?: string
      subtopic?: string
      parking?: boolean
      unfiled?: boolean
      archived?: boolean
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
          archived: filter?.archived,
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

  /** 读取单条资料详情，供预览抽屉使用 */
  const getSource = useCallback(async (sourceId: string): Promise<WikiSourceDetail | null> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      return (await api.sendCommand({
        type: 'wiki:source:get',
        sourceId,
      })) as WikiSourceDetail | null
    } catch {
      return null
    }
  }, [])

  /** 资料检索：返回命中和显式降级信息，UI 据此展示降级文案。 */
  const searchSources = useCallback(
    async (
      keyword: string,
      limit?: number,
    ): Promise<{ hits: readonly WikiSourceSearchHit[]; mode: SearchMode; degradeReason: string | null }> => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand || !keyword.trim()) {
        return { hits: [], mode: 'fts', degradeReason: null }
      }
      setLoading(true)
      try {
        const r = (await api.sendCommand({
          type: 'wiki:search',
          agentId: DEFAULT_AGENT_ID,
          keyword,
          limit,
        })) as { hits: WikiSourceSearchHit[]; mode: SearchMode; degradeReason: string | null }
        return {
          hits: Array.isArray(r?.hits) ? r.hits : [],
          mode: r?.mode ?? 'fts',
          degradeReason: r?.degradeReason ?? null,
        }
      } catch {
        return { hits: [], mode: 'fts', degradeReason: null }
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  /** 确保 workspace/wiki/ 目录存在，并回填已有资料到磁盘。 */
  const ensureVaultLayout = useCallback(async (): Promise<{ vaultRoot: string; synced: number } | null> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return null
    try {
      return (await api.sendCommand({
        type: 'wiki:vault:ensure-layout',
        agentId: DEFAULT_AGENT_ID,
        backfill: true,
      })) as { vaultRoot: string; synced: number }
    } catch {
      return null
    }
  }, [])

  return {
    loading,
    listInbox,
    countInbox,
    retryInbox,
    discardInbox,
    organizeInbox,
    scanFolder,
    importFolder,
    runOrganize,
    listRuns,
    rebuildIndex,
    cleanupScan,
    archiveSources,
    restoreSources,
    deleteSources,
    exportSources,
    getGraphData,
    extractEroFromSources,
    listEntitySources,
    loadTopicTree,
    setTopicTree,
    mutateTopic,
    createNote,
    renameSource,
    runReclassify,
    estimateReclassify,
    getReclassifyRun,
    applyReclassify,
    ignoreReclassify,
    discardReclassify,
    listSources,
    updateSourceTopic,
    moveToParking,
    openSource,
    getSource,
    searchSources,
    ensureVaultLayout,
    loadAutoClassifySetting,
    setAutoClassifyEnabled,
  }
}
