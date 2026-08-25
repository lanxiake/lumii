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

export interface WikiInboxRetryCommand {
  readonly type: 'wiki:inbox:retry'
  readonly inboxId: string
}

export interface WikiInboxDiscardCommand {
  readonly type: 'wiki:inbox:discard'
  readonly inboxId: string
}

/** 手动指定分类立即归档：绕开 AI 分类，直接把一条收件箱条目写为页面 */
export interface WikiInboxOrganizeCommand {
  readonly type: 'wiki:inbox:organize'
  readonly inboxId: string
  readonly path: string
  readonly title?: string
  readonly contentMd?: string
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
  : T extends 'user:abort' ? void
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
      createdAt: number
    }[]
  : T extends 'wiki:inbox:retry' ? { success: boolean }
  : T extends 'wiki:inbox:discard' ? { success: boolean }
  : T extends 'wiki:inbox:organize' ? { pageId: string; path: string }
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
  : T extends 'wiki:search' ? readonly {
      pageId: string
      path: string
      category: string
      title: string
      snippet: string
      updatedAt: number
    }[]
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
      createdAt: number
      finishedAt: number | null
    }[]
  : T extends 'wiki:index:rebuild' ? { rebuiltCount: number }
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
