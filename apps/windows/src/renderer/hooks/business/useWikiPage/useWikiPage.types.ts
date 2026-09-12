/**
 * useWikiPage.types.ts — Wiki 域数据类型
 *
 * 与 Agent Runtime Wiki 命令载荷对齐；由桶 index.ts 统一转出口。
 */

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
  readonly migrateRun?: WikiMigrateRunItem | null
}

/** 库级迁移进度（与 IPC wiki:migrate:progress 对齐） */
export interface WikiMigrateProgressItem {
  readonly runId: string
  readonly phase: string
  readonly phaseLabel: string
  readonly done: number
  readonly total: number
  readonly currentItem: string | null
  readonly message?: string
  readonly appliedCount?: number
  readonly cancelRequested?: boolean
}

/** 库级迁移单文件夹映射（与 IPC MigrateFolderMapping 对齐） */
export interface WikiMigrateMappingItem {
  readonly folderRel: string
  readonly category: string | null
  readonly subtopic: string | null
  readonly confidence: number
  readonly reason: string
  readonly proposedSubtopic?: string
  readonly approvedProposedSubtopic?: boolean
  readonly ignored?: boolean
  readonly status: 'ok' | 'conflict' | 'needContent'
  readonly inboxIds: readonly string[]
}

/** 库级迁移 run 摘要（与 IPC WikiMigrateRunDto 对齐） */
export interface WikiMigrateRunItem {
  readonly runId: string
  readonly phase: string
  readonly importRoot: string
  readonly inboxIds: readonly string[]
  readonly mappings: readonly WikiMigrateMappingItem[]
  readonly appliedSourceIds?: readonly string[]
  readonly appliedInboxIds?: readonly string[]
  readonly cancelRequested: boolean
  readonly progress: WikiMigrateProgressItem
  readonly error: string | null
}

/** update-mapping 可写字段 */
export interface WikiMigrateMappingPatch {
  readonly category?: string | null
  readonly subtopic?: string | null
  readonly approvedProposedSubtopic?: boolean
  readonly ignored?: boolean
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
  readonly userPath?: string[] | null
  readonly tags?: string[] | null
  readonly description?: string | null
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
  readonly userPath?: string[] | null
  readonly tags?: string[] | null
  readonly description?: string | null
  readonly renameTitle?: string
  readonly applyError?: string
}

export interface WikiReclassifyRunItem {
  readonly runId: string
  readonly status: 'running' | 'review' | 'applying' | 'failed' | 'discarded' | 'cancelled'
  readonly total: number
  readonly processed: number
  readonly droppedInvalid: number
  readonly unchanged: number
  readonly error: string | null
  readonly candidates: readonly WikiReclassifyCandidateItem[]
  readonly cancelRequested?: boolean
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
  /** @deprecated 已废弃，使用 userPath 替代 */
  readonly topicProject: string | null
  readonly userPath?: string[] | null
  readonly tags?: string[] | null
  readonly description?: string | null
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
  readonly project?: string | null
  readonly userPath?: string[] | null
  readonly tags?: string[] | null
  readonly snippet: string
  readonly mediaType: string
  readonly sourcePath: string | null
  readonly updatedAt: number
}
