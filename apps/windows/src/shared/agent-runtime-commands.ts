/**
 * Agent Runtime IPC 命令类型定义
 *
 * 所有从渲染进程发送到主进程的 Agent Runtime 命令。
 * 通过 'agent-runtime:command' 通道传输，type 字段区分命令类型。
 *
 * 设计依据: .qoder/design/client-agent-runtime/08-前端渲染与IPC通讯.md §2.2
 */

import type { ContentBlock, ConversationMessageNewEvent } from './agent-runtime-events'

// ============================================================
// 用户交互命令
// ============================================================

export interface UserSendCommand {
  readonly type: 'user:send'
  readonly sessionKey: string
  readonly content: string
  readonly attachments?: readonly string[]
  /** 指定 Agent ID，不传则使用默认 Agent */
  readonly agentId?: string
  /**
   * 单次发送覆盖的网关模型 ID（如 deepseek-chat 或 provider/modelId）
   * 由 Bridge 解析为 Model 并传入 LLM 流，无需重建 Agent 实例
   */
  readonly modelId?: string
  /**
   * 客户端生成的消息 ID（UUID），主进程使用此 ID 落库，
   * 确保切换会话后 ID 一致，避免因 ID 不匹配导致消息重复显示。
   */
  readonly msgId?: string
  /** 语音通话 ASR 用户消息：与 content 一并持久化，供气泡回放 */
  readonly isVoice?: boolean
  readonly audioWavBase64?: string
  /**
   * 图片附件的绝对路径列表（已通过 files:import 落盘到 workspace）。
   *
   * 主进程接收到后会读取文件 → base64 → 构造 pi-ai 的 ImageContent 块，
   * 作为多模态 UserMessage 的 content 数组一部分传入 LLM。
   *
   * 仅当 selectedModel.input 包含 'image' 时由前端填充；
   * 否则前端走"先识别再注入文本"路径，不传该字段。
   */
  readonly imageAttachmentPaths?: readonly string[]
}

export interface UserSteerCommand {
  readonly type: 'user:steer'
  readonly runId: string
  /** 在 Agent 执行过程中注入的引导文本 */
  readonly steerText: string
}

export interface UserAbortCommand {
  readonly type: 'user:abort'
  /** 可选 runId（有值时优先按 run 精确中止） */
  readonly runId?: string
  /** 可选会话键，用于主进程在 runId 映射缺失时精确定位实例 */
  readonly sessionKey?: string
}

// ============================================================
// 权限响应命令
// ============================================================

export interface UserPermissionRespondCommand {
  readonly type: 'user:permission:respond'
  readonly requestId: string
  readonly decision: 'allow-once' | 'allow-always' | 'deny'
}

// ============================================================
// ask_user_question 回答命令
// ============================================================

/**
 * 渲染进程在用户提交 ask_user_question Modal 后调用。
 *
 * - `answers`: key=问题文本，value=答案字符串（multiSelect 时以逗号拼接；"Other" 时为自定义文本）
 * - `annotations`: 可选的 notes / preview
 * - `declined`: 用户按"拒绝回答"
 */
export interface UserAskUserRespondCommand {
  readonly type: 'user:ask-user:respond'
  readonly requestId: string
  readonly answers: Record<string, string>
  readonly annotations?: Record<string, { preview?: string; notes?: string }>
  readonly declined?: boolean
}

/**
 * 同步「自动审批」开关到主进程。
 *
 * 该开关原本只是渲染进程 localStorage + useEffect 自动放行，主进程无从知晓。
 * 渠道（飞书/企微/微信）需要它来判断是否值得把审批请求文字化推给用户：
 * 开着时审批会被立刻自动放行，推过去纯属噪音。
 */
export interface UserAutoApproveSetCommand {
  readonly type: 'user:auto-approve:set'
  readonly enabled: boolean
}

// ============================================================
// 会话管理命令
// ============================================================

export interface ConversationCreateCommand {
  readonly type: 'conversation:create'
  readonly title?: string
  readonly agentId?: string
  /**
   * 与聊天页模型下拉 id 一致（如 anthropic/claude-opus-4-6），用于从已同步目录解析 contextWindow
   */
  readonly selectedModelId?: string
}

/** 将 GET /api/config/models 拉平后的条目同步到主进程（用于上下文压缩与用量条） */
export interface RuntimeModelCatalogSetCommand {
  readonly type: 'runtime:modelCatalog:set'
  readonly entries: readonly {
    readonly id: string
    readonly contextWindow?: number
    readonly maxTokens?: number
  }[]
}

/** 仅更新会话级模型偏好与压缩参数（如下拉切换、未发送时） */
export interface SessionPreferredModelSetCommand {
  readonly type: 'session:preferredModel:set'
  readonly sessionKey: string
  readonly modelId?: string
}

/** 更新会话级思考模式与推理强度 */
export interface SessionThinkingPrefsSetCommand {
  readonly type: 'session:thinkingPrefs:set'
  readonly sessionKey: string
  readonly thinkingEnabled?: boolean
  readonly reasoningEffort?: 'high' | 'max'
}

export interface ConversationCloseCommand {
  readonly type: 'conversation:close'
  readonly sessionKey: string
}

export interface ConversationListCommand {
  readonly type: 'conversation:list'
}

/** UI 历史懒加载游标：指向已加载的最早一条消息，请求严格早于它的记录 */
export interface ConversationMessagesCursor {
  /** ISO 时间串（与 DB 中的 messages.timestamp 一致） */
  readonly timestamp: string
  readonly id: string
}

/**
 * 分页读取会话历史（含已被上下文压缩标记的消息，用户仍需回看）。
 * 不传 before 时返回最新一页。
 */
export interface ConversationMessagesCommand {
  readonly type: 'conversation:messages'
  readonly sessionKey: string
  readonly limit?: number
  readonly before?: ConversationMessagesCursor
}

/**
 * 查询指定会话的实时上下文使用量（用于会话切换后立即展示真实窗口占用）
 */
export interface ConversationContextUsageCommand {
  readonly type: 'conversation:context-usage'
  readonly sessionKey: string
}

export interface ConversationDeleteCommand {
  readonly type: 'conversation:delete'
  readonly sessionKey: string
}

export interface ConversationRenameCommand {
  readonly type: 'conversation:rename'
  readonly sessionKey: string
  readonly newTitle: string
}

export interface ConversationPinToggleCommand {
  readonly type: 'conversation:pin-toggle'
  readonly sessionKey: string
}

/** 忽略中断标记 */
export interface ConversationDismissInterruptCommand {
  readonly type: 'conversation:dismiss-interrupt'
  readonly sessionKey: string
}

/** 继续被中断的对话（发送 continuation prompt） */
export interface ConversationContinueInterruptedCommand {
  readonly type: 'conversation:continue-interrupted'
  readonly sessionKey: string
}

export interface CronCreateCommand {
  readonly type: 'cron:create'
  readonly name: string
  readonly taskText: string
  readonly scheduleType: 'at' | 'every' | 'cron'
  readonly scheduleExpr: string
  readonly agentId?: string
  /** 生效星期 "0,1,..,6"（0=周日）；省略表示每天 */
  readonly activeDays?: string
  /** 生效时段 [start, end) 的起止小时；省略表示全天 */
  readonly activeHourStart?: number
  readonly activeHourEnd?: number
  /** 逗号分隔的推送目标：system/news/focus/feishu */
  readonly notifyTargets?: string
}

export interface CronListCommand {
  readonly type: 'cron:list'
  readonly includeDisabled?: boolean
}

export interface CronDeleteCommand {
  readonly type: 'cron:delete'
  readonly id: string
}

export interface CronUpdateCommand {
  readonly type: 'cron:update'
  readonly id: string
  readonly patch: {
    readonly enabled?: boolean
    readonly name?: string
    readonly taskText?: string
    readonly agentId?: string | null
    readonly scheduleType?: 'at' | 'every' | 'cron'
    readonly scheduleExpr?: string
    readonly activeDays?: string
    readonly activeHourStart?: number | null
    readonly activeHourEnd?: number | null
    readonly notifyTargets?: string
  }
}

export interface CronRunCommand {
  readonly type: 'cron:run'
  readonly id: string
}

export interface CronRunsCommand {
  readonly type: 'cron:runs'
  readonly id: string
  readonly limit?: number
}

// ============================================================
// Agent 定义查询
// ============================================================

export interface AgentDefinitionsListCommand {
  readonly type: 'agent:definitions:list'
}

export interface AgentMemoriesListCommand {
  readonly type: 'agent:memories:list'
  /** 对话 ID（与 sessionKey 相同）；不传则仅用 agentId */
  readonly sessionKey?: string
  /** 直接指定 Agent 定义 ID；不传时从 session 解析，再无则 assistant */
  readonly agentId?: string
}

export interface AgentMemoriesDeleteCommand {
  readonly type: 'agent:memories:delete'
  readonly memoryId: string
}

export interface AgentMemoriesUpdateCommand {
  readonly type: 'agent:memories:update'
  readonly memoryId: string
  readonly content: string
}

export interface AgentMemoriesClearCommand {
  readonly type: 'agent:memories:clear'
  readonly sessionKey?: string
  readonly agentId?: string
}

export interface AgentMemoriesExportCommand {
  readonly type: 'agent:memories:export'
  readonly sessionKey?: string
  readonly agentId?: string
}

/** 记忆来源下转（诉求 A）：一条工作记忆 → 来源段 + 段原文区间 + 宫殿片段 */
export interface AgentMemoriesProvenanceCommand {
  readonly type: 'agent:memories:provenance'
  readonly memoryId: string
}

/** 搜索记忆（FTS5 + BM25） */
export interface AgentMemoriesSearchCommand {
  readonly type: 'agent:memories:search'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly keyword: string
  readonly limit?: number
}

/** 归档冷记忆（> 30 天未用且非 personal 类） */
export interface AgentMemoriesArchiveColdCommand {
  readonly type: 'agent:memories:archiveCold'
  readonly sessionKey?: string
  readonly agentId?: string
}

/** 恢复归档记忆 */
export interface AgentMemoriesUnarchiveCommand {
  readonly type: 'agent:memories:unarchive'
  readonly memoryId: string
}

/** 重建 FTS5 索引 */
export interface AgentMemoriesRebuildIndexCommand {
  readonly type: 'agent:memories:rebuildIndex'
}

/** 温度分布统计 */
export interface AgentMemoriesStatsCommand {
  readonly type: 'agent:memories:stats'
  readonly sessionKey?: string
  readonly agentId?: string
}

// ============================================================
// Wiki 知识库命令（P0）
// ============================================================

export interface WikiInboxListCommand {
  readonly type: 'wiki:inbox:list'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly status?: 'pending' | 'organized' | 'discarded'
}

export interface WikiInboxCountCommand {
  readonly type: 'wiki:inbox:count'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly status?: 'pending' | 'organized' | 'discarded'
}

export interface WikiInboxRetryCommand {
  readonly type: 'wiki:inbox:retry'
  readonly inboxId: string
}

export interface WikiInboxDiscardCommand {
  readonly type: 'wiki:inbox:discard'
  readonly inboxId: string
}

/** 手动指定用途分类立即归档：绕开 AI 分类，直接把一条收件箱条目写入资料层 */
export interface WikiInboxOrganizeCommand {
  readonly type: 'wiki:inbox:organize'
  readonly inboxId: string
  readonly category: string
  readonly subtopic: string
  readonly title?: string
}

export interface WikiPageListCommand {
  readonly type: 'wiki:page:list'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly category?: string
}

export interface WikiPageGetCommand {
  readonly type: 'wiki:page:get'
  readonly pageId: string
}

export interface WikiPageUpdateCommand {
  readonly type: 'wiki:page:update'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly path: string
  readonly title: string
  readonly contentMd: string
}

export interface WikiPageDeleteCommand {
  readonly type: 'wiki:page:delete'
  readonly pageId: string
}

export interface WikiSearchCommand {
  readonly type: 'wiki:search'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly keyword: string
  readonly limit?: number
  /** 显式关闭向量，只走全文检索（用于测试与降级排查） */
  readonly enableVector?: boolean
}

export interface WikiSourceGetCommand {
  readonly type: 'wiki:source:get'
  readonly sourceId: string
}

export interface WikiRunsListCommand {
  readonly type: 'wiki:runs:list'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly limit?: number
}

export interface WikiIndexRebuildCommand {
  readonly type: 'wiki:index:rebuild'
}

// ============================================================
// Wiki 用途主题树 / 资料层命令（记忆重构一期）
// ============================================================

export interface WikiTopicTreeGetCommand {
  readonly type: 'wiki:topic:tree:get'
  readonly agentId: string
  readonly userId?: string
}

export interface WikiTopicTreeSetCommand {
  readonly type: 'wiki:topic:tree:set'
  readonly agentId: string
  readonly userId?: string
  readonly tree: {
    readonly version: 1
    readonly categories: ReadonlyArray<{ readonly name: string; readonly subtopics: readonly string[] }>
  }
}

/** 删除节点时的文件去向；删除有文件的节点必须带 disposition */
export type WikiFileDispositionDto =
  | { readonly type: 'parking' }
  | { readonly type: 'move'; readonly category: string; readonly subtopic: string }

/** 主题树九种变更操作；只由用户 UI 触发，AI 不可调用 */
export type WikiTopicMutationDto =
  | { readonly op: 'addCategory'; readonly name: string; readonly index?: number }
  | { readonly op: 'renameCategory'; readonly from: string; readonly to: string }
  | { readonly op: 'deleteCategory'; readonly name: string; readonly disposition?: WikiFileDispositionDto }
  | { readonly op: 'reorderCategories'; readonly names: readonly string[] }
  | { readonly op: 'addSubtopic'; readonly category: string; readonly name: string; readonly index?: number }
  | { readonly op: 'renameSubtopic'; readonly category: string; readonly from: string; readonly to: string }
  | { readonly op: 'deleteSubtopic'; readonly category: string; readonly name: string; readonly disposition?: WikiFileDispositionDto }
  | { readonly op: 'moveSubtopic'; readonly fromCategory: string; readonly name: string; readonly toCategory: string; readonly index?: number }
  | { readonly op: 'mergeSubtopic'; readonly fromCategory: string; readonly fromName: string; readonly toCategory: string; readonly toName: string }

export interface WikiTopicMutateCommand {
  readonly type: 'wiki:topic:mutate'
  readonly agentId: string
  readonly userId?: string
  readonly mutation: WikiTopicMutationDto
}

export interface WikiSourceCreateNoteCommand {
  readonly type: 'wiki:source:create-note'
  readonly agentId: string
  readonly userId?: string
  readonly category: string
  readonly subtopic: string
  readonly title?: string
}

export interface WikiSourceRenameCommand {
  readonly type: 'wiki:source:rename'
  readonly agentId: string
  readonly userId?: string
  readonly sourceId: string
  readonly title: string
}

// ---- 重新编目（二期）----

export interface WikiReclassifyRunCommand {
  readonly type: 'wiki:reclassify:run'
  readonly agentId: string
  readonly userId?: string
  readonly scope: 'source' | 'subtopic' | 'all'
  readonly sourceId?: string
  readonly category?: string
  readonly subtopic?: string
  /** 已有待审阅批次时是否丢弃旧批次继续 */
  readonly force?: boolean
}

export interface WikiReclassifyGetCommand {
  readonly type: 'wiki:reclassify:get'
  readonly agentId: string
  readonly userId?: string
}

export interface WikiReclassifyApplyCommand {
  readonly type: 'wiki:reclassify:apply'
  readonly agentId: string
  readonly userId?: string
  readonly candidateIds: readonly string[]
}

export interface WikiReclassifyIgnoreCommand {
  readonly type: 'wiki:reclassify:ignore'
  readonly agentId: string
  readonly userId?: string
  readonly candidateId: string
}

export interface WikiReclassifyDiscardCommand {
  readonly type: 'wiki:reclassify:discard'
  readonly agentId: string
  readonly userId?: string
}

export interface WikiSourceListCommand {
  readonly type: 'wiki:source:list'
  readonly agentId: string
  readonly userId?: string
  readonly category?: string
  readonly subtopic?: string
  readonly parking?: boolean
  readonly unfiled?: boolean
  readonly mediaType?: string
}

export interface WikiSourceUpdateTopicCommand {
  readonly type: 'wiki:source:update-topic'
  readonly agentId: string
  readonly sourceId: string
  readonly category: string
  readonly subtopic: string | null
}

export interface WikiSourceMoveToParkingCommand {
  readonly type: 'wiki:source:move-to-parking'
  readonly agentId: string
  readonly sourceId: string
}

export interface WikiSourceOpenCommand {
  readonly type: 'wiki:source:open'
  readonly agentId: string
  readonly sourceId: string
}

// ============================================================
// Wiki 知识库命令（P1）
// ============================================================

/** 查某页反链：源页信息由 pageId 反查所属 agent/user，无需额外传归属 */
export interface WikiLinkBacklinksCommand {
  readonly type: 'wiki:link:backlinks'
  readonly pageId: string
}

export interface WikiLinkUnresolvedCommand {
  readonly type: 'wiki:link:unresolved'
  readonly sessionKey?: string
  readonly agentId?: string
}

export interface WikiPageRevisionsCommand {
  readonly type: 'wiki:page:revisions'
  readonly pageId: string
}

export interface WikiPageRollbackCommand {
  readonly type: 'wiki:page:rollback'
  readonly pageId: string
  readonly targetVersion: number
}

export interface WikiCleanupScanCommand {
  readonly type: 'wiki:cleanup:scan'
  readonly sessionKey?: string
  readonly agentId?: string
  /** 长期未用判定天数阈值，默认 90 */
  readonly staleDays?: number
}

export interface WikiSourceArchiveCommand {
  readonly type: 'wiki:source:archive'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly sourceIds: readonly string[]
}

export interface WikiSourceRestoreCommand {
  readonly type: 'wiki:source:restore'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly sourceIds: readonly string[]
}

export interface WikiSourceDeleteCommand {
  readonly type: 'wiki:source:delete'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly sourceIds: readonly string[]
}

export interface WikiAttachListCommand {
  readonly type: 'wiki:attach:list'
  readonly pageId: string
}

export interface WikiAttachAddCommand {
  readonly type: 'wiki:attach:add'
  readonly pageId: string
  readonly filePath: string
  readonly mediaType: 'document' | 'image' | 'audio' | 'video'
  readonly displayName: string
  readonly sourceId?: string
}

export interface WikiAttachRemoveCommand {
  readonly type: 'wiki:attach:remove'
  readonly attachmentId: string
}

export interface WikiExportCommand {
  readonly type: 'wiki:export'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly targetDir: string
  readonly includeSources?: boolean
  readonly includeAttachments?: boolean
}

export interface WikiConceptScanCommand {
  readonly type: 'wiki:concept:scan'
  readonly sessionKey?: string
  readonly agentId?: string
  /** 参与扫描的最近资料条数上限，默认 30 */
  readonly limit?: number
}

export interface WikiConceptConfirmCommand {
  readonly type: 'wiki:concept:confirm'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly name: string
  readonly conceptType: 'concept' | 'entity'
}

export interface WikiConceptRejectCommand {
  readonly type: 'wiki:concept:reject'
  readonly name: string
  readonly conceptType: 'concept' | 'entity'
}

export interface WikiSynthesisCreateCommand {
  readonly type: 'wiki:synthesis:create'
  readonly sessionKey?: string
  readonly agentId?: string
  /** 参与合成的页面 id 列表；与 category 二选一（category 优先展开为该分类下全部页） */
  readonly pageIds?: readonly string[]
  /** 按分类全选页面发起合成（历史页面路径，值是 sources/media 这类顶层分类） */
  readonly category?: string
  /** 二期主路径：以资料为输入 */
  readonly sourceIds?: readonly string[]
  /**
   * 二期：按用途目录取资料。故意不复用 category —— 它在历史路径里指页面顶层分类，
   * 复用会让「只给大类」的调用静默走错分支。
   */
  readonly topicCategory?: string
  readonly topicSubtopic?: string
  /** 超量确认标记：UI 收到数量警告后带上这个重发 */
  readonly confirmed?: boolean
  readonly title?: string
}

/**
 * 资料合成超量时的错误码。主进程把它写进 message 前缀，渲染进程据此判定
 * 「需要二次确认」——不匹配中文文案，改文案不会破坏判断。
 */
export const SYNTHESIS_CONFIRM_REQUIRED_CODE = 'WIKI_SYNTHESIS_CONFIRM_REQUIRED'

export interface WikiSynthesisAcceptAsSourceCommand {
  readonly type: 'wiki:synthesis:accept-as-source'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly synthesisId: string
  readonly category: string
  readonly subtopic: string
}

export interface WikiSynthesisListCommand {
  readonly type: 'wiki:synthesis:list'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly status?: 'candidate' | 'accepted' | 'rejected'
}

export interface WikiSynthesisGetCommand {
  readonly type: 'wiki:synthesis:get'
  readonly synthesisId: string
}

export interface WikiSynthesisAcceptCommand {
  readonly type: 'wiki:synthesis:accept'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly synthesisId: string
}

export interface WikiSynthesisRejectCommand {
  readonly type: 'wiki:synthesis:reject'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly synthesisId: string
}

/** 一键自动综述：串行生成 sources/media 稳定 overview 页 */
export interface WikiSynthesisAutoRunCommand {
  readonly type: 'wiki:synthesis:auto-run'
  readonly sessionKey?: string
  readonly agentId?: string
}

export interface WikiGraphDataCommand {
  readonly type: 'wiki:graph:data'
  readonly sessionKey?: string
  readonly agentId?: string
  /** 中心页 id（兼容旧路径，强制走历史层） */
  readonly centerPageId?: string
  /** 大类，与 centerPageId 二选一；全空时缺省到主题树第一个大类 */
  readonly category?: string
  /** 小类（可选） */
  readonly subtopic?: string
  /** 邻域半径，默认 1；centerPageId 路径下影响 page 双链扩散，category 路径下无效 */
  readonly radius?: number
  /** source+entity 节点上限，默认 50 */
  readonly limit?: number
  /** 图层，默认 ['structure', 'entities'] */
  readonly layers?: Array<'structure' | 'entities' | 'history'>
}

export interface WikiStatusScanCommand {
  readonly type: 'wiki:status:scan'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly staleDays?: number
}

export interface WikiStatusConfirmCommand {
  readonly type: 'wiki:status:confirm'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly pageId: string
  /** 确认采纳建议状态，或 reject 清除候选 */
  readonly action: 'confirm' | 'reject'
  readonly status?: 'outdated' | 'doubtful' | 'archived'
}

export interface WikiEroBootstrapCommand {
  readonly type: 'wiki:ero:bootstrap'
  readonly sessionKey?: string
  readonly agentId?: string
}

export interface WikiEroListCommand {
  readonly type: 'wiki:ero:list'
  readonly sessionKey?: string
  readonly agentId?: string
  /** 指定实体时仅返回该实体的活跃观察摘要 */
  readonly entityId?: string
}

export interface WikiEroExtractCommand {
  readonly type: 'wiki:ero:extract'
  readonly sessionKey?: string
  readonly agentId?: string
  /** 默认 'sources'；'pages' 保持旧行为（extractRecent，服务历史页面图层） */
  readonly target?: 'sources' | 'pages'
  /** target='sources' 时的范围：category（+可选 subtopic）或显式 sourceIds */
  readonly category?: string
  readonly subtopic?: string
  readonly sourceIds?: readonly string[]
  /** target='pages' 时沿用的旧参数 */
  readonly maxPages?: number
  readonly maxCharsPerPage?: number
}

/** 三期：实体出现于哪些资料（实体侧栏） */
export interface WikiEroEntitySourcesCommand {
  readonly type: 'wiki:ero:entity-sources'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly entityId: string
}

export interface WikiSearchHybridCommand {
  readonly type: 'wiki:search:hybrid'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly keyword: string
  readonly limit?: number
  /** 默认 true；false 时仅 FTS 并返回 degradeReason */
  readonly enableVector?: boolean
}

export interface WikiVectorRebuildCommand {
  readonly type: 'wiki:vector:rebuild'
  readonly sessionKey?: string
  readonly agentId?: string
}

// ============================================================
// 工具管理命令
// ============================================================

export interface ToolsListCommand {
  readonly type: 'tools:list'
}

export interface ToolsToggleCommand {
  readonly type: 'tools:toggle'
  readonly toolName: string
  readonly enabled: boolean
}

export interface McpStatusCommand {
  readonly type: 'mcp:status'
}

/** MCP Server 配置（与主进程 McpServerEntry 一致） */
export interface McpServerConfigInput {
  readonly name: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly cwd?: string
  readonly enabled?: boolean
}

export interface McpUpsertCommand {
  readonly type: 'mcp:upsert'
  readonly entry: McpServerConfigInput
  /** 编辑已有条目时传入原名称，用于支持改名 */
  readonly originalName?: string
}

export interface McpImportCommand {
  readonly type: 'mcp:import'
  readonly entries: readonly McpServerConfigInput[]
}

export interface McpRemoveCommand {
  readonly type: 'mcp:remove'
  readonly name: string
}

export interface McpSetEnabledCommand {
  readonly type: 'mcp:setEnabled'
  readonly name: string
  readonly enabled: boolean
}

/**
 * 会话级启停 MCP server（设置页的 mcp:setEnabled 是全局总开关）。
 * 全局关闭的 server 无法在会话里单独开启。
 */
export interface McpSetSessionEnabledCommand {
  readonly type: 'mcp:setSessionEnabled'
  readonly sessionKey: string
  readonly name: string
  readonly enabled: boolean
}

/** 读取会话级 MCP 禁用集 */
export interface McpSessionDisabledCommand {
  readonly type: 'mcp:sessionDisabled'
  readonly sessionKey: string
}

/**
 * 会话级启停技能（技能中心的启用/禁用是全局总开关）。
 * 全局未启用的技能无法在会话里单独开启。
 */
export interface SkillSetSessionEnabledCommand {
  readonly type: 'skill:setSessionEnabled'
  readonly sessionKey: string
  readonly skillId: string
  readonly enabled: boolean
}

/** 读取会话级技能禁用集 */
export interface SkillSessionDisabledCommand {
  readonly type: 'skill:sessionDisabled'
  readonly sessionKey: string
}

export interface McpReconnectCommand {
  readonly type: 'mcp:reconnect'
  readonly name: string
}

/** 读取 mcp-servers.json 原文 */
export interface McpReadConfigFileCommand {
  readonly type: 'mcp:readConfigFile'
}

/** 写入 mcp-servers.json 原文并重载全部连接 */
export interface McpWriteConfigFileCommand {
  readonly type: 'mcp:writeConfigFile'
  readonly content: string
}

/** mcp:status 返回的单条运行时状态 */
export interface McpServerStatusResult extends McpServerConfigInput {
  readonly connected: boolean
  readonly connecting: boolean
  readonly tools: readonly string[]
  readonly lastError?: string
  /** 该 server 工具定义的估算 token（与上下文用量条同一口径） */
  readonly estimatedTokens?: number
}

/** mcp:status 的完整返回（含配置文件级错误） */
export interface McpStatusPayload {
  readonly servers: readonly McpServerStatusResult[]
  readonly configError?: string
}

// ============================================================
// 主进程桥接（原独立 IPC，统一经 sendCommand）
// ============================================================

export interface RuntimePingCommand {
  readonly type: 'runtime:ping'
}

export interface RuntimeFeatureFlagsGetCommand {
  readonly type: 'runtime:featureFlags:get'
}

export interface RuntimeFeatureFlagsSetCommand {
  readonly type: 'runtime:featureFlags:set'
  readonly flags: Record<string, boolean>
}

export interface RuntimeEnabledCommand {
  readonly type: 'runtime:enabled'
}

export interface AgentInstanceCreateCommand {
  readonly type: 'agentInstance:create'
  readonly agentDef?: unknown
}

export interface AgentInstanceCreateByIdCommand {
  readonly type: 'agentInstance:createById'
  readonly agentId: string
}

export interface AgentDefinitionSyncStatusCommand {
  readonly type: 'agentDefinition:syncStatus'
}

export interface AgentDefinitionSyncUserAgentsCommand {
  readonly type: 'agentDefinition:syncUserAgents'
}

export interface AgentDefinitionCacheListCommand {
  readonly type: 'agentDefinition:cacheList'
}

export interface AgentDefinitionCacheRemoveCommand {
  readonly type: 'agentDefinition:cacheRemove'
  readonly agentId: string
}

export interface AgentDefinitionCacheClearOlderCommand {
  readonly type: 'agentDefinition:cacheClearOlder'
  readonly cutoffIso: string
}

export interface AgentDefinitionCacheClearAllCommand {
  readonly type: 'agentDefinition:cacheClearAll'
}

export interface AgentDefinitionCacheRefreshCommand {
  readonly type: 'agentDefinition:cacheRefresh'
  readonly agentId: string
}

export interface AgentInstancePromptCommand {
  readonly type: 'agentInstance:prompt'
  readonly instanceId: string
  readonly message: string
}

export interface AgentInstanceAbortCommand {
  readonly type: 'agentInstance:abort'
  readonly instanceId: string
}

export interface AgentInstanceDestroyCommand {
  readonly type: 'agentInstance:destroy'
  readonly instanceId: string
}

export interface AgentInstanceListCommand {
  readonly type: 'agentInstance:list'
}

export interface AgentInstanceLifecycleSnapshotCommand {
  readonly type: 'agentInstance:lifecycleSnapshot'
  readonly definitionId: string
}

export interface StorageStatsCommand {
  readonly type: 'storage:stats'
}

export interface StorageExportJsonlCommand {
  readonly type: 'storage:exportJsonl'
}

export interface StorageClearMalformedCommand {
  readonly type: 'storage:clearMalformed'
}

/** 列出本地 SQLite 自动备份 */
export interface StorageListBackupsCommand {
  readonly type: 'storage:listBackups'
}

/** 立即创建本地 SQLite 备份 */
export interface StorageCreateBackupCommand {
  readonly type: 'storage:createBackup'
}

/** 从指定备份文件恢复聊天记录 */
export interface StorageRestoreBackupCommand {
  readonly type: 'storage:restoreBackup'
  readonly backupFileName: string
}

/** 从最新备份恢复聊天记录 */
export interface StorageRestoreLatestBackupCommand {
  readonly type: 'storage:restoreLatestBackup'
}

/** 删除指定备份文件 */
export interface StorageDeleteBackupCommand {
  readonly type: 'storage:deleteBackup'
  readonly backupFileName: string
}

/** 拉取最近工具审计记录（含权限决策摘要） */
export interface StorageAuditRecentCommand {
  readonly type: 'storage:auditRecent'
  readonly limit?: number
}

// ============================================================
// 消息管理命令
// ============================================================

export interface MessageDeleteCommand {
  readonly type: 'message:delete'
  readonly messageId: string
  readonly sessionKey: string
}

export interface MessageEditCommand {
  readonly type: 'message:edit'
  readonly messageId: string
  readonly sessionKey: string
  readonly newContent: string
}

// ============================================================
// 编辑分支命令
// ============================================================

/**
 * 基于当前历史创建新对话分支。
 * 复制 sourceSessionKey 中 uptoMessageId（含）之前的历史到新会话，并追加编辑后的 user 消息。
 * 返回 { sessionKey: string } — 新会话的 key。
 */
export interface ConversationForkCommand {
  readonly type: 'conversation:fork'
  readonly sourceSessionKey: string
  /** 复制至（含）此消息 ID，该消息的后续历史不复制 */
  readonly uptoMessageId: string
  /** 编辑后的用户消息内容 */
  readonly newContent: string
}

/**
 * 编辑用户消息并重新触发回答（删除该消息之后的所有消息，然后重发）。
 * 等价于：deleteMessagesAfter(messageId) + updateMessageContent + resend。
 */
export interface MessageEditAndResendCommand {
  readonly type: 'message:edit-and-resend'
  readonly sessionKey: string
  readonly messageId: string
  readonly newContent: string
}

// ============================================================
// 命令注册表查询
// ============================================================

/** 查询客户端可用的基础斜杠命令列表 */
export interface CommandsListCommand {
  readonly type: 'commands:list'
}

/** 按会话列出 TaskRepo 中的任务（重启后恢复 TodoPanel） */
export interface TasksListCommand {
  readonly type: 'tasks:list'
  /** 会话 key / conversationId */
  readonly conversationId: string
}

/** 命令列表条目（通用跨渠道格式） */
export interface CommandListEntry {
  readonly key: string
  readonly name: string
  readonly aliases: readonly string[]
  readonly description: string
  readonly usage?: string
  readonly category: string
  readonly acceptsArgs: boolean
}

// ============================================================
// 上下文压缩命令
// ============================================================

export interface UserCompactContextCommand {
  readonly type: 'user:compact-context'
  readonly sessionKey: string
  /** 保留最近 N 轮对话，默认 6 */
  readonly keepRecentTurns?: number
}

/** 用户手动停止正在进行的上下文压缩 */
export interface UserAbortCompactContextCommand {
  readonly type: 'user:abort-compact-context'
  readonly sessionKey: string
}

// ============================================================
// 文件管理命令
// ============================================================

/** 分页查询文件列表 */
export interface FilesListCommand {
  readonly type: 'files:list'
  readonly userId: string
  readonly agentId?: string
  readonly conversationId?: string
  readonly channel?: string
  readonly category?: 'upload' | 'output'
  readonly limit?: number
  readonly offset?: number
}

/** 按关键词 + 过滤条件搜索文件 */
export interface FilesSearchCommand {
  readonly type: 'files:search'
  readonly userId: string
  readonly query: string
  readonly filters?: {
    readonly agentId?: string
    readonly conversationId?: string
    readonly channel?: string
    readonly dateFrom?: string
    readonly dateTo?: string
  }
}

/** 批量软删除文件 */
export interface FilesDeleteCommand {
  readonly type: 'files:delete'
  readonly fileIds: readonly string[]
  readonly userId: string
}

/** 用系统默认应用打开文件 */
export interface FilesOpenCommand {
  readonly type: 'files:open'
  readonly fileId: string
  readonly userId: string
}

/** 另存为指定路径 */
export interface FilesSaveAsCommand {
  readonly type: 'files:save-as'
  readonly fileId: string
  readonly userId: string
  readonly savePath: string
}

/** 读取文件内容用于预览（带 10MB 安全上限） */
export interface FilesReadPreviewContentCommand {
  readonly type: 'files:read-preview-content'
  readonly fileId: string
  readonly userId: string
}

/** 将外部文件导入到 workspace uploads 目录并注册到 FileRepo */
export interface FilesImportCommand {
  readonly type: 'files:import'
  readonly userId: string
  /** 源文件绝对路径（来自 Electron File.path）；与 fileBuffer 二选一 */
  readonly sourcePath?: string
  /** 原始文件名 */
  readonly fileName: string
  /** MIME 类型 */
  readonly mimeType: string
  /** 文件内容 base64（当 sourcePath 不可用时使用，如拖拽上传） */
  readonly fileBuffer?: string
  /** 关联的会话 key（可选） */
  readonly conversationId?: string
}

/** 按绝对/相对路径读取文件内容用于预览（工具卡片场景）
 *
 * 与 files:read-preview-content 的区别：不依赖 FileRepo 注册；
 * 只要路径在当前 Agent workspace 内，即可读取。
 * 用于读取/写入类工具卡片上的"点击文件名预览"。
 */
export interface FilesReadPreviewByPathCommand {
  readonly type: 'files:read-preview-by-path'
  readonly filePath: string
  readonly userId: string
  /** 可选：只预览指定行号范围（1-based，含） */
  readonly startLine?: number
  readonly endLine?: number
}

export interface CodingDevSetBackendCommand {
  readonly type: 'codingDev:setBackend'
  /** 目标后端 ID（如 'claude'、'codex'、'opencode'） */
  readonly backendId: string
  /** 作用域：'peer'（per-peer）或 'user-global' */
  readonly scope: 'peer' | 'user-global'
  /** 账号 ID（微信 channelUserId 或 Windows 用户 ID） */
  readonly accountId: string
  /** 会话 sessionKey（scope='peer' 时必填） */
  readonly peerId?: string
}

export interface CodingDevGetBackendCommand {
  readonly type: 'codingDev:getBackend'
  readonly accountId: string
  readonly peerId?: string
}

export interface CodingDevListBackendsCommand {
  readonly type: 'codingDev:listBackends'
}

// ============================================================
// 图片处理（识别 / 美化 / 裁剪等；按策略扩展）
// ============================================================

/**
 * 图片识别：调用多模态模型（优先国内小模型，如 Qwen-VL / GLM-4V / Doubao-Vision）
 * 对图片内容进行理解，返回描述文本 + 可选 OCR 文本。
 *
 * 在 Agent 使用的模型本身支持多模态时，可跳过此调用（Agent 会直接看图）。
 * 当 Agent 使用纯文本模型时，前端可先识别，再把识别结果注入消息文本。
 */
export interface ImageRecognizeCommand {
  readonly type: 'image:recognize'
  /** workspace 内绝对路径或相对 cwd 路径 */
  readonly imagePath: string
  /** 可选：指定识别用的模型 id；省略则按 config 默认（优先国内） */
  readonly modelId?: string
  /** 可选：自定义识别提示词（默认：简要描述图片内容并提取其中可见的文字） */
  readonly prompt?: string
  /** 可选：是否附带 OCR（默认 true） */
  readonly includeOcr?: boolean
}

/**
 * 图片生成：通过 AI 模型根据文字描述生成图片。
 * 支持模型：gpt-image-2 / gpt-image-2-vip / nano-banana 系列
 */
export interface ImageGenerateCommand {
  readonly type: 'image:generate'
  readonly prompt: string
  readonly modelId?: string
  readonly width?: number
  readonly height?: number
}

/**
 * 图片处理（美化 / 风格化 / 抠图 / 水印 / 压缩等）。
 *
 * 当前仅定义接口占位，具体策略由后续按 operation 注册具体处理器实现。
 * 前端只需传递 operation + options，后端根据 operation 路由到具体策略。
 */
export interface ImageProcessCommand {
  readonly type: 'image:process'
  /** 输入图片路径（workspace 内） */
  readonly imagePath: string
  /** 处理操作名称（由具体策略注册，如 'beautify' / 'upscale' / 'bg-remove'） */
  readonly operation: string
  /** 策略特定参数 */
  readonly options?: Record<string, unknown>
}

// ============================================================
// 技能自进化命令
// ============================================================

/** 确认技能草稿（写入磁盘并激活） */
export interface SkillConfirmDraftCommand {
  readonly type: 'skill:confirm_draft'
  readonly draft: {
    readonly id: string
    readonly skillMd: string
    readonly humanSummary: {
      readonly title: string
      readonly scenario: string
      readonly steps: readonly string[]
    }
    readonly qualityScore: number
    readonly createdAt: string
  }
}

/** 拒绝技能草稿（删除 pending 记录） */
export interface SkillRejectDraftCommand {
  readonly type: 'skill:reject_draft'
  readonly draftId: string
}

/** 废弃技能 */
export interface SkillDeprecateCommand {
  readonly type: 'skill:deprecate'
  readonly skillName: string
}

// ============================================================
// 联合类型
// ============================================================

/** 所有 Agent Runtime 命令的联合类型 */
export type AgentRuntimeCommand =
  | UserSendCommand
  | UserSteerCommand
  | UserAbortCommand
  | UserPermissionRespondCommand
  | UserAskUserRespondCommand
  | UserAutoApproveSetCommand
  | RuntimeModelCatalogSetCommand
  | SessionPreferredModelSetCommand
  | SessionThinkingPrefsSetCommand
  | ConversationCreateCommand
  | ConversationCloseCommand
  | ConversationListCommand
  | ConversationMessagesCommand
  | ConversationContextUsageCommand
  | ConversationDeleteCommand
  | ConversationRenameCommand
  | ConversationPinToggleCommand
  | ConversationDismissInterruptCommand
  | ConversationContinueInterruptedCommand
  | CronCreateCommand
  | CronListCommand
  | CronDeleteCommand
  | CronUpdateCommand
  | CronRunCommand
  | CronRunsCommand
  | AgentDefinitionsListCommand
  | AgentMemoriesListCommand
  | AgentMemoriesDeleteCommand
  | AgentMemoriesUpdateCommand
  | AgentMemoriesClearCommand
  | AgentMemoriesExportCommand
  | AgentMemoriesProvenanceCommand
  | AgentMemoriesSearchCommand
  | AgentMemoriesArchiveColdCommand
  | AgentMemoriesUnarchiveCommand
  | AgentMemoriesRebuildIndexCommand
  | AgentMemoriesStatsCommand
  | WikiInboxListCommand
  | WikiInboxCountCommand
  | WikiInboxRetryCommand
  | WikiInboxDiscardCommand
  | WikiInboxOrganizeCommand
  | WikiPageListCommand
  | WikiPageGetCommand
  | WikiPageUpdateCommand
  | WikiPageDeleteCommand
  | WikiSearchCommand
  | WikiSourceGetCommand
  | WikiRunsListCommand
  | WikiIndexRebuildCommand
  | WikiTopicTreeGetCommand
  | WikiTopicTreeSetCommand
  | WikiTopicMutateCommand
  | WikiReclassifyRunCommand
  | WikiReclassifyGetCommand
  | WikiReclassifyApplyCommand
  | WikiReclassifyIgnoreCommand
  | WikiReclassifyDiscardCommand
  | WikiSourceCreateNoteCommand
  | WikiSourceRenameCommand
  | WikiSourceListCommand
  | WikiSourceUpdateTopicCommand
  | WikiSourceMoveToParkingCommand
  | WikiSourceOpenCommand
  | WikiLinkBacklinksCommand
  | WikiLinkUnresolvedCommand
  | WikiPageRevisionsCommand
  | WikiPageRollbackCommand
  | WikiCleanupScanCommand
  | WikiSourceArchiveCommand
  | WikiSourceRestoreCommand
  | WikiSourceDeleteCommand
  | WikiAttachListCommand
  | WikiAttachAddCommand
  | WikiAttachRemoveCommand
  | WikiExportCommand
  | WikiConceptScanCommand
  | WikiConceptConfirmCommand
  | WikiConceptRejectCommand
  | WikiSynthesisCreateCommand
  | WikiSynthesisListCommand
  | WikiSynthesisGetCommand
  | WikiSynthesisAcceptCommand
  | WikiSynthesisAcceptAsSourceCommand
  | WikiSynthesisRejectCommand
  | WikiSynthesisAutoRunCommand
  | WikiGraphDataCommand
  | WikiStatusScanCommand
  | WikiStatusConfirmCommand
  | WikiEroBootstrapCommand
  | WikiEroListCommand
  | WikiEroExtractCommand
  | WikiEroEntitySourcesCommand
  | WikiSearchHybridCommand
  | WikiVectorRebuildCommand
  | ToolsListCommand
  | ToolsToggleCommand
  | McpStatusCommand
  | McpUpsertCommand
  | McpImportCommand
  | McpRemoveCommand
  | McpSetEnabledCommand
  | McpSetSessionEnabledCommand
  | McpSessionDisabledCommand
  | SkillSetSessionEnabledCommand
  | SkillSessionDisabledCommand
  | McpReconnectCommand
  | McpReadConfigFileCommand
  | McpWriteConfigFileCommand
  | RuntimePingCommand
  | RuntimeFeatureFlagsGetCommand
  | RuntimeFeatureFlagsSetCommand
  | RuntimeEnabledCommand
  | AgentInstanceCreateCommand
  | AgentInstanceCreateByIdCommand
  | AgentDefinitionSyncStatusCommand
  | AgentDefinitionSyncUserAgentsCommand
  | AgentDefinitionCacheListCommand
  | AgentDefinitionCacheRemoveCommand
  | AgentDefinitionCacheClearOlderCommand
  | AgentDefinitionCacheClearAllCommand
  | AgentDefinitionCacheRefreshCommand
  | AgentInstancePromptCommand
  | AgentInstanceAbortCommand
  | AgentInstanceDestroyCommand
  | AgentInstanceListCommand
  | AgentInstanceLifecycleSnapshotCommand
  | StorageStatsCommand
  | StorageExportJsonlCommand
  | StorageClearMalformedCommand
  | StorageListBackupsCommand
  | StorageCreateBackupCommand
  | StorageRestoreBackupCommand
  | StorageRestoreLatestBackupCommand
  | StorageDeleteBackupCommand
  | StorageAuditRecentCommand
  | MessageDeleteCommand
  | MessageEditCommand
  | ConversationForkCommand
  | MessageEditAndResendCommand
  | UserCompactContextCommand
  | UserAbortCompactContextCommand
  | FilesListCommand
  | FilesSearchCommand
  | FilesDeleteCommand
  | FilesOpenCommand
  | FilesSaveAsCommand
  | FilesReadPreviewContentCommand
  | FilesReadPreviewByPathCommand
  | FilesImportCommand
  | CommandsListCommand
  | TasksListCommand
  | CodingDevSetBackendCommand
  | CodingDevGetBackendCommand
  | CodingDevListBackendsCommand
  | ImageRecognizeCommand
  | ImageGenerateCommand
  | ImageProcessCommand
  | SkillConfirmDraftCommand
  | SkillRejectDraftCommand
  | SkillDeprecateCommand

// ============================================================
// 命令返回类型映射
// ============================================================

/** 命令返回类型的条件类型映射，确保类型安全 */
export type AgentRuntimeCommandResult<T extends AgentRuntimeCommand['type']> =
  T extends 'user:send' ? { runId: string }
  : T extends 'user:steer' ? void
  : T extends 'user:abort' ? { ok: true }
  : T extends 'user:permission:respond' ? void
  : T extends 'user:ask-user:respond' ? void
  : T extends 'runtime:modelCatalog:set' ? { ok: boolean }
  : T extends 'session:preferredModel:set' ? {
      usedTokens: number
      contextWindow: number
      triggerThreshold: number
    }
  : T extends 'session:thinkingPrefs:set' ? {
      thinkingEnabled: boolean
      reasoningEffort: 'high' | 'max'
    }
  : T extends 'conversation:create' ? { sessionKey: string }
  : T extends 'conversation:close' ? void
  : T extends 'conversation:list' ? readonly {
      sessionKey: string
      title: string
      updatedAt: string
      agentId?: string
      lastMessagePreview?: string
      hasRunning?: boolean
      isPinned?: boolean
      wasInterrupted?: boolean
    }[]
  : T extends 'conversation:messages' ? {
      /** 按时间升序的一页消息 */
      items: readonly ConversationMessageNewEvent['message'][]
      /** 是否还有更早的历史可继续上滑加载 */
      hasMore: boolean
      /** 本页最早一条消息的游标，回传给 before 即可取更早的一页 */
      nextCursor?: ConversationMessagesCursor
    }
  : T extends 'conversation:context-usage' ? {
      usedTokens: number
      contextWindow: number
      triggerThreshold: number
    }
  : T extends 'conversation:delete' ? void
  : T extends 'conversation:rename' ? { success: boolean }
  : T extends 'conversation:pin-toggle' ? { isPinned: boolean }
  : T extends 'conversation:dismiss-interrupt' ? { ok: boolean }
  : T extends 'conversation:continue-interrupted' ? { ok: boolean; error?: string }
  : T extends 'cron:create' ? {
      status: 'ok' | 'error'
      job?: {
        id: string
        name: string
        scheduleType: 'at' | 'every' | 'cron'
        scheduleExpr: string
        nextRunAt?: number
        intervalMs?: number
        enabled: boolean
      }
      message?: string
    }
  : T extends 'cron:list' ? {
      status: 'ok'
      jobs: readonly {
        id: string
        name: string
        taskText: string
        agentId?: string
        scheduleType: 'at' | 'every' | 'cron'
        scheduleExpr: string
        nextRunAt: number
        intervalMs?: number
        enabled: boolean
        createdAt: number
        lastRunAt?: number
        lastStatus?: 'ok' | 'error' | 'running'
        activeDays?: string
        activeHourStart?: number
        activeHourEnd?: number
        notifyTargets?: string
      }[]
      total: number
    }
  : T extends 'cron:delete' ? { status: 'ok' | 'not_found' | 'error'; id: string; message?: string }
  : T extends 'cron:update' ? { status: 'ok' | 'not_found' | 'error'; id: string; message?: string }
  : T extends 'cron:run' ? { status: 'ok' | 'not_found' | 'error'; id: string; message?: string }
  : T extends 'cron:runs' ? {
      status: 'ok'
      entries: readonly {
        id: string
        status: 'ok' | 'error'
        startedAt: number
        finishedAt: number
        durationMs: number
        summary?: string
        error?: string
      }[]
    }
  : T extends 'agent:definitions:list' ? readonly {
      id: string
      name: string
      description: string
      model?: string
    }[]
  : T extends 'agent:memories:list' ? readonly {
      id: string
      category: string
      content: string
      importance: number
      createdAt: number
      sourceSegmentId: string | null
      palaceDrawerId: string | null
    }[]
  : T extends 'agent:memories:delete' ? { success: boolean }
  : T extends 'agent:memories:update' ? { success: boolean }
  : T extends 'agent:memories:clear' ? { deletedCount: number }
  : T extends 'agent:memories:export' ? { json: string }
  : T extends 'agent:memories:provenance' ? {
      memoryId: string
      sourceSegmentId: string | null
      sourceMessageId: string | null
      palaceDrawerId: string | null
      originalText: string | null
      segment: {
        id: string
        conversationId: string
        startMessageId: string
        endMessageId: string | null
        createdAt: string
        turnCount: number
        charCount: number
      } | null
    } | null
  : T extends 'agent:memories:search' ? readonly {
      id: string
      category: string
      content: string
      importance: number
      createdAt: number
    }[]
  : T extends 'agent:memories:archiveCold' ? { archivedCount: number }
  : T extends 'agent:memories:unarchive' ? { success: boolean }
  : T extends 'agent:memories:rebuildIndex' ? { rebuiltCount: number }
  : T extends 'agent:memories:stats' ? {
      hot: number
      warm: number
      cold: number
      total: number
    }
  : T extends 'wiki:inbox:list' ? readonly {
      id: string
      itemType: string
      title: string
      contentPreview: string | null
      mediaType: string
      status: string
      attemptCount: number
      lastError: string | null
      lastOutcome: string | null
      createdAt: number
    }[]
  : T extends 'wiki:inbox:count' ? { total: number; pending: number; unfiled: number }
  : T extends 'wiki:inbox:retry' ? { success: boolean }
  : T extends 'wiki:inbox:discard' ? { success: boolean }
  : T extends 'wiki:inbox:organize' ? { sourceId: string; category: string; subtopic: string }
  : T extends 'wiki:page:list' ? readonly {
      id: string
      path: string
      category: string
      title: string
      version: number
      updatedAt: number
    }[]
  : T extends 'wiki:page:get' ? {
      id: string
      path: string
      category: string
      title: string
      contentMd: string
      version: number
      updatedAt: number
    } | null
  : T extends 'wiki:page:update' ? { pageId: string; version: number }
  : T extends 'wiki:page:delete' ? { success: boolean }
  : T extends 'wiki:search' ? {
      hits: readonly {
        sourceId: string
        title: string
        category: string | null
        subtopic: string | null
        snippet: string
        mediaType: string
        sourcePath: string | null
        updatedAt: number
      }[]
      mode: 'fts' | 'vector' | 'hybrid'
      degradeReason: string | null
    }
  : T extends 'wiki:source:get' ? {
      id: string
      title: string
      sourcePath: string | null
      mediaType: string
      extractedText: string | null
      originContext: string | null
      createdAt: number
    } | null
  : T extends 'wiki:runs:list' ? readonly {
      id: string
      inboxIds: readonly string[]
      status: string
      resultSummary: string | null
      error: string | null
      resultDetail: {
        items: readonly {
          inboxId: string
          title: string
          path: string
          mediaType: string
          outcome: string
          reason?: string
          extract: string
        }[]
      } | null
      createdAt: number
      finishedAt: number | null
    }[]
  : T extends 'wiki:index:rebuild' ? { rebuiltCount: number }
  : T extends 'wiki:topic:tree:get' ? {
      tree: { version: 1; categories: readonly { name: string; subtopics: readonly string[] }[] }
    }
  : T extends 'wiki:topic:tree:set' ? { success: true }
  : T extends 'wiki:topic:mutate' ? {
      tree: { version: 1; categories: readonly { name: string; subtopics: readonly string[] }[] }
      movedCount: number
    }
  : T extends 'wiki:reclassify:run' ? { runId: string }
  : T extends 'wiki:reclassify:get' ? {
      run: {
        runId: string
        status: 'running' | 'review' | 'applying' | 'failed' | 'discarded'
        total: number
        processed: number
        droppedInvalid: number
        unchanged: number
        error: string | null
        candidates: readonly {
          id: string
          sourceId: string
          title: string
          fromCategory: string
          fromSubtopic: string
          toCategory: string
          toSubtopic: string
          reason: string
          applyError?: string
        }[]
      } | null
    }
  : T extends 'wiki:source:create-note' ? { sourceId: string; sourcePath: string; title: string }
  : T extends 'wiki:source:rename' ? { id: string; title: string }
  : T extends 'wiki:reclassify:apply' ? { applied: number; failed: number }
  : T extends 'wiki:reclassify:ignore' ? { success: true }
  : T extends 'wiki:reclassify:discard' ? { success: true }
  : T extends 'wiki:source:list' ? {
      sources: readonly {
        id: string
        title: string
        sourcePath: string | null
        mediaType: string
        topicCategory: string | null
        topicSubtopic: string | null
        updatedAt: number
        useCount: number
      }[]
    }
  : T extends 'wiki:source:update-topic' ? {
      id: string
      topicCategory: string | null
      topicSubtopic: string | null
    }
  : T extends 'wiki:source:move-to-parking' ? {
      id: string
      topicCategory: string | null
      topicSubtopic: string | null
    }
  : T extends 'wiki:source:open' ? { success: true }
  : T extends 'wiki:link:backlinks' ? readonly {
      linkId: string
      sourcePageId: string
      sourceTitle: string
      sourcePath: string
      anchorText: string
      isResolved: boolean
    }[]
  : T extends 'wiki:link:unresolved' ? readonly {
      id: string
      sourcePageId: string
      anchorText: string
      createdAt: number
    }[]
  : T extends 'wiki:page:revisions' ? readonly {
      id: string
      version: number
      title: string
      editor: string
      sourceRef: string | null
      createdAt: number
      contentMd: string
    }[]
  : T extends 'wiki:page:rollback' ? { pageId: string; version: number }
  : T extends 'wiki:cleanup:scan' ? readonly {
      sourceId: string
      title: string
      reason: 'stale' | 'broken_source' | 'duplicate_content'
      duplicateOfSourceId?: string
      topicCategory?: string | null
      topicSubtopic?: string | null
      suggestedAction?: 'parking' | 'delete'
    }[]
  : T extends 'wiki:source:archive' ? { archived: number }
  : T extends 'wiki:source:restore' ? { restored: number }
  : T extends 'wiki:source:delete' ? { deleted: number }
  : T extends 'wiki:attach:list' ? readonly {
      id: string
      pageId: string
      sourceId: string | null
      filePath: string
      mediaType: string
      displayName: string
      createdAt: number
    }[]
  : T extends 'wiki:attach:add' ? {
      id: string
      pageId: string
      sourceId: string | null
      filePath: string
      mediaType: string
      displayName: string
      createdAt: number
    }
  : T extends 'wiki:attach:remove' ? { success: boolean }
  : T extends 'wiki:export' ? {
      exported: number
      failed: readonly { path: string; error: string }[]
    }
  : T extends 'wiki:concept:scan' ? readonly {
      name: string
      type: 'concept' | 'entity'
      evidenceSourceIds: readonly string[]
      suggestedContentMd: string
    }[]
  : T extends 'wiki:concept:confirm' ? { pageId: string; path: string }
  : T extends 'wiki:concept:reject' ? { success: boolean }
  : T extends 'wiki:synthesis:create' ? { synthesisId: string }
  : T extends 'wiki:synthesis:accept-as-source' ? {
      sourceId: string
      category: string
      subtopic: string
    }
  : T extends 'wiki:synthesis:list' ? readonly {
      id: string
      title: string
      status: string
      sourcePageIds: readonly string[]
      outputPath: string | null
      error: string | null
      progress: { chunk: number; total: number } | null
      pageId: string | null
      createdAt: number
      finishedAt: number | null
    }[]
  : T extends 'wiki:synthesis:get' ? {
      id: string
      title: string
      status: string
      candidateMd: string
      sourcePageIds: readonly string[]
      sourceIds: readonly string[] | null
      sourcePages: readonly { id: string; title: string; path: string }[]
      outputPath: string | null
      error: string | null
      progress: { chunk: number; total: number } | null
      pageId: string | null
      createdAt: number
      finishedAt: number | null
    }
  : T extends 'wiki:synthesis:accept' ? { pageId: string; path: string }
  : T extends 'wiki:synthesis:reject' ? { success: boolean }
  : T extends 'wiki:synthesis:auto-run' ? {
      results: readonly {
        category: string
        pageId: string
        path: string
        skipped?: boolean
        error?: string
      }[]
    }
  : T extends 'wiki:graph:data' ? {
      nodes: readonly {
        id: string
        kind: 'page' | 'entity' | 'category' | 'subtopic' | 'source'
        title: string
        path?: string
        category?: string
        useCount?: number
        entityType?: string
        pageId?: string | null
        topicCategory?: string | null
        topicSubtopic?: string | null
      }[]
      edges: readonly {
        id: string
        kind: 'wikilink' | 'relation' | 'belongs_to' | 'sibling' | 'mentioned_in'
        source: string
        target: string
        label: string
        anchorText?: string
        strength?: number
      }[]
      truncated: boolean
    }
  : T extends 'wiki:status:scan' ? readonly {
      pageId: string
      title: string
      path: string
      suggestedStatus: string
      reason: string
    }[]
  : T extends 'wiki:status:confirm' ? { success: boolean }
  : T extends 'wiki:ero:bootstrap' ? { entities: number; relations: number }
  : T extends 'wiki:ero:list' ? {
      entities: readonly unknown[]
      relations: readonly unknown[]
      observations?: readonly {
        id: string
        entity_id: string
        content: string
        source_page_id: string | null
        created_at: string
      }[]
    }
  : T extends 'wiki:ero:extract' ? {
      // target='pages' 旧路径字段
      pagesProcessed?: number
      // target='sources'（默认）路径字段
      sourcesScanned?: number
      sourcesSkipped?: number
      sourcesFailed?: number
      entitiesUpserted: number
      relationsUpserted: number
      observationsAdded: number
      errors: readonly (string | { sourceId: string; title: string; message: string })[]
    }
  : T extends 'wiki:ero:entity-sources' ? {
      sources: readonly {
        id: string
        title: string
        sourcePath: string | null
        topicCategory: string | null
        topicSubtopic: string | null
        mediaType: string
      }[]
    }
  : T extends 'wiki:search:hybrid' ? {
      hits: readonly {
        pageId: string
        path: string
        category: string
        title: string
        snippet: string
        updatedAt: number
        mode: string
      }[]
      degradeReason: string | null
      mode: string
      backend?: string
    }
  : T extends 'wiki:vector:rebuild' ? { rebuiltCount: number; backend?: string; notice?: string | null }
  : T extends 'tools:list' ? readonly {
      name: string
      label: string
      description: string
      category: string
      isReadOnly: boolean
      needsPermission: boolean
      enabled: boolean
      /** 累计调用次数，从未调用过为 0 */
      usageCount: number
      /** 最后一次调用时刻（epoch ms），从未调用过时缺省 */
      lastUsedAt?: number
    }[]
  : T extends 'tools:toggle' ? { success: boolean }
  : T extends 'mcp:status' ? McpStatusPayload
  : T extends 'mcp:readConfigFile' ? { path: string; content: string }
  : T extends 'mcp:writeConfigFile' ? { success: boolean; error?: string }
  : T extends 'mcp:upsert' | 'mcp:import' | 'mcp:remove' | 'mcp:setEnabled' | 'mcp:reconnect'
    ? { success: boolean; error?: string }
  : T extends 'mcp:setSessionEnabled' | 'mcp:sessionDisabled'
    ? { disabledServers: readonly string[] }
  : T extends 'skill:setSessionEnabled' | 'skill:sessionDisabled'
    ? { disabledSkills: readonly string[] }
  : T extends 'storage:auditRecent' ? readonly {
      id: number
      agent_id: string
      tool_name: string
      result_summary: string | null
      is_error: number
      duration_ms: number | null
      timestamp: string
    }[]
  : T extends 'user:compact-context' ? {
      success: boolean
      previousMessageCount: number
      newMessageCount: number
      messagesRemoved: number
    }
  : T extends 'files:list' ? {
      files: readonly {
        id: string
        userId: string
        agentId: string | null
        conversationId: string | null
        messageId: string | null
        channel: string
        sourceType: string
        fileName: string
        fileSize: number | null
        mimeType: string | null
        localPath: string
        category: 'upload' | 'output'
        metadata: Record<string, unknown> | null
        createdAt: string
        updatedAt: string
        deletedAt: string | null
      }[]
      total: number
    }
  : T extends 'files:search' ? readonly {
      id: string
      fileName: string
      localPath: string
      fileSize: number | null
      mimeType: string | null
      createdAt: string
      channel: string
      agentId: string | null
      conversationId: string | null
    }[]
  : T extends 'files:delete' ? { deletedCount: number }
  : T extends 'files:open' ? { success: boolean }
  : T extends 'files:save-as' ? { success: boolean }
  : T extends 'files:read-preview-content' ? {
      truncated: boolean
      content: string | null
      size: number
      mimeType: string | null
      /** 默认按 utf-8 文本；PDF/Office/图片等二进制为 base64 */
      encoding?: 'utf-8' | 'base64'
    }
  : T extends 'files:read-preview-by-path' ? {
      truncated: boolean
      content: string | null
      size: number
      mimeType: string | null
      /** 规范化后的文件名（basename） */
      fileName: string
      /** 是否按行号范围截取了内容 */
      ranged: boolean
      /** 实际返回的起始行号（1-based） */
      startLine?: number
      /** 实际返回的结束行号（1-based，含） */
      endLine?: number
      /** 与 files:read-preview-content 一致；二进制为 base64 */
      encoding?: 'utf-8' | 'base64'
      /**
       * 大音视频按 path 预览：lumii-local 协议 URL（不读满 base64）。
       * 有 fileUrl 时 content 可为 null。
       */
      fileUrl?: string
    }
  : T extends 'commands:list' ? readonly CommandListEntry[]
  : T extends 'tasks:list' ? {
      tasks: readonly {
        id: string
        subject: string
        description: string | null
        status: string
        owner: string | null
      }[]
    }
  : T extends 'files:import' ? {
      fileId: string
      /** workspace 内的相对路径 */
      localPath: string
      /** workspace 内的绝对路径 */
      absPath: string
      fileName: string
      mimeType: string
      fileSize: number
      /** 伴生文本文件的 workspace 相对路径；null 表示该格式无需/无法解析 */
      parsedTextPath: string | null
    }
  : T extends 'image:recognize' ? {
      /** 图片内容的自然语言描述 */
      description: string
      /** 提取的 OCR 文字（无则为空串） */
      ocrText: string
      /** 实际使用的模型 id */
      modelId: string
      /** 模型提供方（openai / qwen / zhipu / doubao / ...） */
      provider: string
    }
  : T extends 'image:process' ? {
      /** 处理后生成的文件路径（workspace 相对路径） */
      outputPath: string
      /** 操作名称回显 */
      operation: string
      /** 具体策略返回的附加信息 */
      meta?: Record<string, unknown>
    }
  : T extends 'image:generate' ? {
      /** workspace 相对路径，如 outputs/20260517/generated_a1b2.png */
      filePath: string
      width: number
      height: number
      /** 实际使用的模型 id */
      model: string
      /** 模型优化后的完整 prompt，迭代修改时传入下一次 prompt */
      revisedPrompt: string
    }
  : never

// ============================================================
// 统一命令错误响应
// ============================================================

/** IPC 命令统一错误响应（bridge 未就绪或命令执行失败时） */
export interface AgentRuntimeCommandError {
  readonly ok: false
  readonly error: string
}

/** 检查命令响应是否为错误（ok === false） */
export function isCommandError(result: unknown): result is AgentRuntimeCommandError {
  return (
    typeof result === 'object' &&
    result !== null &&
    'ok' in result &&
    (result as { ok: unknown }).ok === false
  )
}
