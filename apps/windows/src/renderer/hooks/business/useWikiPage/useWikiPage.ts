/**
 * useWikiPage — 通过 Agent Runtime IPC 管理 Wiki 知识库（P0）
 *
 * 范式同 useMemoryUsage：window.electronAPI.agentRuntime.sendCommand 通用透传；
 * 命令统一经 wiki-command.ts 的 sendWikiCommand（运行时守卫 + agentId 注入）。
 */

import { useCallback, useState } from 'react'
import { sendWikiCommand } from './wiki-command'
import type {
  WikiInboxItem,
  WikiFolderScanResult,
  WikiFolderImportResult,
  WikiRunItem,
  WikiCleanupSuggestionItem,
  WikiExportResultItem,
  WikiGraphDataItem,
  WikiGraphQuery,
  WikiEroExtractSourceResult,
  WikiEntitySourceRef,
  WikiTopicTree,
  WikiTopicMutation,
  WikiTopicMutateResult,
  WikiSourceDetail,
  WikiReclassifyScopeDto,
  WikiReclassifyRunItem,
  WikiReclassifyEstimateItem,
  WikiSourceListItem,
  WikiSourceSearchHit,
  SearchMode,
  WikiMigrateRunItem,
  WikiMigrateProgressItem,
  WikiMigrateMappingPatch,
} from './useWikiPage.types'

export function useWikiPage() {
  const [loading, setLoading] = useState(false)

  const listInbox = useCallback(async (status?: string): Promise<readonly WikiInboxItem[]> => {
    setLoading(true)
    try {
      const rows = (await sendWikiCommand({
        type: 'wiki:inbox:list',
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
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:inbox:count',
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
    try {
      const r = (await sendWikiCommand({ type: 'wiki:inbox:retry', inboxId })) as { success: boolean }
      return !!r?.success
    } catch {
      return false
    }
  }, [])

  const discardInbox = useCallback(async (inboxId: string): Promise<boolean> => {
    try {
      const r = (await sendWikiCommand({ type: 'wiki:inbox:discard', inboxId })) as { success: boolean }
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
      /** @deprecated 使用 userPath 替代 */
      project: string | null,
      title?: string,
      options?: {
        userPath?: string[] | null;
        tags?: string[] | null;
        description?: string | null;
      },
    ): Promise<{ sourceId: string; category: string; subtopic: string | null; project: string | null; userPath?: string[] | null; tags?: string[] | null; description?: string | null } | null> => {
      try {
        return (await sendWikiCommand({
          type: 'wiki:inbox:organize',
          inboxId,
          category,
          subtopic,
          project,
          title,
          userPath: options?.userPath,
          tags: options?.tags,
          description: options?.description,
        })) as { sourceId: string; category: string; subtopic: string | null; project: string | null; userPath?: string[] | null; tags?: string[] | null; description?: string | null }
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
    try {
      return (await sendWikiCommand({
        type: 'wiki:folder:scan',
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
      try {
        return (await sendWikiCommand({
          type: 'wiki:folder:import',
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
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:auto-classify:get',
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
    try {
      await sendWikiCommand({
        type: 'wiki:auto-classify:set',
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
      try {
        return (await sendWikiCommand({
          type: 'wiki:organize:run',
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
    try {
      const rows = (await sendWikiCommand({ type: 'wiki:runs:list', limit })) as WikiRunItem[]
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }, [])

  const rebuildIndex = useCallback(async (): Promise<number> => {
    try {
      const r = (await sendWikiCommand({ type: 'wiki:index:rebuild' })) as { rebuiltCount: number }
      return r?.rebuiltCount ?? 0
    } catch {
      return 0
    }
  }, [])

  const cleanupScan = useCallback(async (staleDays?: number): Promise<readonly WikiCleanupSuggestionItem[]> => {
    setLoading(true)
    try {
      const rows = (await sendWikiCommand({
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
    try {
      const r = (await sendWikiCommand({ type: 'wiki:source:archive', sourceIds })) as { archived: number }
      return r?.archived ?? 0
    } catch {
      return 0
    }
  }, [])

  const restoreSources = useCallback(async (sourceIds: readonly string[]): Promise<number> => {
    try {
      const r = (await sendWikiCommand({ type: 'wiki:source:restore', sourceIds })) as { restored: number }
      return r?.restored ?? 0
    } catch {
      return 0
    }
  }, [])

  const deleteSources = useCallback(async (sourceIds: readonly string[]): Promise<number> => {
    try {
      const r = (await sendWikiCommand({ type: 'wiki:source:delete', sourceIds })) as { deleted: number }
      return r?.deleted ?? 0
    } catch {
      return 0
    }
  }, [])

  const exportSources = useCallback(
    async (targetDir: string): Promise<WikiExportResultItem | null> => {
      setLoading(true)
      try {
        const r = (await sendWikiCommand({
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
    try {
      return (await sendWikiCommand({
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
      try {
        return (await sendWikiCommand({
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
    if (!entityId) return []
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:ero:entity-sources',
        entityId,
      })) as { sources: readonly WikiEntitySourceRef[] }
      return Array.isArray(r.sources) ? r.sources : []
    } catch {
      return []
    }
  }, [])

  const loadTopicTree = useCallback(async (): Promise<WikiTopicTree | null> => {
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:topic:tree:get',
      })) as { tree: WikiTopicTree }
      return r?.tree ?? null
    } catch {
      return null
    }
  }, [])

  const setTopicTree = useCallback(async (tree: WikiTopicTree): Promise<boolean> => {
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:topic:tree:set',
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
      try {
        const r = (await sendWikiCommand({
          type: 'wiki:topic:mutate',
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
      try {
        const r = (await sendWikiCommand({
          type: 'wiki:source:create-note',
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
    try {
      await sendWikiCommand({
        type: 'wiki:source:rename',
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
      try {
        const r = (await sendWikiCommand({
          type: 'wiki:reclassify:run',
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
      try {
        return (await sendWikiCommand({
          type: 'wiki:reclassify:estimate',
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
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:reclassify:get',
      })) as { run: WikiReclassifyRunItem | null }
      return r?.run ?? null
    } catch {
      return null
    }
  }, [])

  const applyReclassify = useCallback(
    async (candidateIds: readonly string[]): Promise<{ applied: number; failed: number }> => {
      try {
        return (await sendWikiCommand({
          type: 'wiki:reclassify:apply',
          candidateIds,
        })) as { applied: number; failed: number }
      } catch {
        return { applied: 0, failed: 0 }
      }
    },
    [],
  )

  const ignoreReclassify = useCallback(async (candidateId: string): Promise<boolean> => {
    try {
      await sendWikiCommand({
        type: 'wiki:reclassify:ignore',
        candidateId,
      })
      return true
    } catch {
      return false
    }
  }, [])

  const discardReclassify = useCallback(async (): Promise<boolean> => {
    try {
      await sendWikiCommand({ type: 'wiki:reclassify:discard' })
      return true
    } catch {
      return false
    }
  }, [])

  const cancelReclassify = useCallback(async (): Promise<boolean> => {
    try {
      await sendWikiCommand({ type: 'wiki:reclassify:cancel' })
      return true
    } catch {
      return false
    }
  }, [])

  const listSources = useCallback(
    async (filter?: {
      category?: string
      subtopic?: string
      subtopicUnfiled?: boolean
      parking?: boolean
      unfiled?: boolean
      archived?: boolean
      mediaType?: string
    }): Promise<readonly WikiSourceListItem[]> => {
      setLoading(true)
      try {
        const r = (await sendWikiCommand({
          type: 'wiki:source:list',
          category: filter?.category,
          subtopic: filter?.subtopic,
          subtopicUnfiled: filter?.subtopicUnfiled,
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

  /**
   * 拉取左栏角标计数（GROUP BY，不含正文）。
   */
  const loadSourceCounts = useCallback(async (): Promise<{
    sectionCounts: Record<string, number>
    topicCounts: Record<string, number>
    parking: number
    unfiled: number
    filed: number
    archived: number
  } | null> => {
    try {
      return (await sendWikiCommand({
        type: 'wiki:source:counts',
      })) as {
        sectionCounts: Record<string, number>
        topicCounts: Record<string, number>
        parking: number
        unfiled: number
        filed: number
        archived: number
      }
    } catch {
      return null
    }
  }, [])

  const updateSourceTopic = useCallback(
    async (
      sourceId: string,
      category: string,
      subtopic: string | null,
      /** @deprecated 使用 options.userPath 替代 */
      project: string | null,
      options?: {
        userPath?: string[] | null;
        tags?: string[] | null;
        description?: string | null;
      },
    ): Promise<boolean> => {
      try {
        const r = (await sendWikiCommand({
          type: 'wiki:source:update-topic',
          sourceId,
          category,
          subtopic,
          project,
          userPath: options?.userPath,
          tags: options?.tags,
          description: options?.description,
        })) as { id: string }
        return !!r?.id
      } catch {
        return false
      }
    },
    [],
  )

  const moveToParking = useCallback(async (sourceId: string): Promise<boolean> => {
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:source:move-to-parking',
        sourceId,
      })) as { id: string }
      return !!r?.id
    } catch {
      return false
    }
  }, [])

  /** 失败把 error 抛给调用方，让 UI 展示「无法打开原文件」等具体原因 */
  const openSource = useCallback(async (sourceId: string): Promise<void> => {
    await sendWikiCommand({ type: 'wiki:source:open', sourceId })
  }, [])

  /** 读取单条资料详情，供预览抽屉使用 */
  const getSource = useCallback(async (sourceId: string): Promise<WikiSourceDetail | null> => {
    try {
      return (await sendWikiCommand({
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
      if (!keyword.trim()) {
        return { hits: [], mode: 'fts', degradeReason: null }
      }
      setLoading(true)
      try {
        const r = (await sendWikiCommand({
          type: 'wiki:search',
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

  /**
   * 确保 workspace/wiki/ 分区目录存在。
   * 默认不做全库 backfill：800+ 资料时逐条 sync 会堵死进页（可达十余秒）。
   * 需要回填时显式传 `{ backfill: true }`。
   */
  const ensureVaultLayout = useCallback(
    async (opts?: { backfill?: boolean }): Promise<{ vaultRoot: string; synced: number } | null> => {
      try {
        return (await sendWikiCommand({
          type: 'wiki:vault:ensure-layout',
          backfill: opts?.backfill === true,
        })) as { vaultRoot: string; synced: number }
      } catch {
        return null
      }
    },
    [],
  )

  /**
   * 读取当前库级迁移 run（含 progress）。
   */
  const getMigrateRun = useCallback(async (): Promise<WikiMigrateRunItem | null> => {
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:migrate:get',
      })) as { run: WikiMigrateRunItem | null }
      return r?.run ?? null
    } catch {
      return null
    }
  }, [])

  /**
   * 请求停止当前 migrate（inventory / planning / applying）。
   */
  const cancelMigrate = useCallback(async (): Promise<WikiMigrateRunItem | null> => {
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:migrate:cancel',
      })) as { run: WikiMigrateRunItem | null }
      return r?.run ?? null
    } catch {
      return null
    }
  }, [])

  /**
   * 订阅 migrate 进度推送（wiki:migrate:progress）。
   */
  const subscribeMigrateProgress = useCallback(
    (handler: (progress: WikiMigrateProgressItem) => void): (() => void) => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.onWikiMigrateProgress) return () => undefined
      return api.onWikiMigrateProgress((payload: unknown) => {
        if (!payload || typeof payload !== 'object') return
        const p = payload as WikiMigrateProgressItem
        if (typeof p.runId !== 'string' || typeof p.phase !== 'string') return
        handler(p)
      })
    },
    [],
  )

  /**
   * 用户确认 review 映射后执行 apply，逐条归档 inbox。
   */
  const applyMigrate = useCallback(async (): Promise<WikiMigrateRunItem | null> => {
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:migrate:apply',
      })) as { run: WikiMigrateRunItem }
      return r?.run ?? null
    } catch {
      return null
    }
  }, [])

  /**
   * 丢弃当前 migrate 映射方案；inbox 保持 pending。
   */
  const discardMigrate = useCallback(async (): Promise<boolean> => {
    try {
      await sendWikiCommand({
        type: 'wiki:migrate:discard',
      })
      return true
    } catch {
      return false
    }
  }, [])

  /**
   * 撤销本 run 已落位的 source，退回收件箱。
   */
  const undoMigrate = useCallback(async (): Promise<WikiMigrateRunItem | null> => {
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:migrate:undo',
      })) as { run: WikiMigrateRunItem }
      return r?.run ?? null
    } catch {
      return null
    }
  }, [])

  /**
   * 对仍 pending 的本批 inbox 重跑盘点 + 映射 → review。
   */
  const replanMigrate = useCallback(async (): Promise<WikiMigrateRunItem | null> => {
    try {
      const r = (await sendWikiCommand({
        type: 'wiki:migrate:replan',
      })) as { run: WikiMigrateRunItem }
      return r?.run ?? null
    } catch {
      return null
    }
  }, [])

  /**
   * 预览中改单簇映射、批准 proposedSubtopic 或标记 ignored。
   */
  const updateMigrateMapping = useCallback(
    async (folderRel: string, patch: WikiMigrateMappingPatch): Promise<WikiMigrateRunItem | null> => {
      try {
        const r = (await sendWikiCommand({
          type: 'wiki:migrate:update-mapping',
          folderRel,
          patch,
        })) as { run: WikiMigrateRunItem }
        return r?.run ?? null
      } catch {
        return null
      }
    },
    [],
  )

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
    cancelReclassify,
    listSources,
    loadSourceCounts,
    updateSourceTopic,
    moveToParking,
    openSource,
    getSource,
    searchSources,
    ensureVaultLayout,
    loadAutoClassifySetting,
    setAutoClassifyEnabled,
    getMigrateRun,
    cancelMigrate,
    subscribeMigrateProgress,
    applyMigrate,
    discardMigrate,
    undoMigrate,
    replanMigrate,
    updateMigrateMapping,
  }
}
