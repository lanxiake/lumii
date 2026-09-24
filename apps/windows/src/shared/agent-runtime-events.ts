/**
 * Agent Runtime IPC 事件类型定义
 *
 * 所有从主进程推送到渲染进程的 Agent Runtime 事件。
 * 通过 'agent-runtime:event' 通道传输，type 字段区分事件类型。
 *
 * 设计依据: .qoder/design/client-agent-runtime/08-前端渲染与IPC通讯.md §2.1
 */
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'

// ============================================================
// 共享数据结构
// ============================================================

/** 消息内容块 */
export interface ContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** Token 用量统计 */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** 网关 / 流式层结构化错误（与 createGatewayStreamFn 对齐） */
interface GatewayLlmErrorDetail {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly httpStatus?: number
}

/**
 * 多 Agent：来源实例与对话聚合键（主 Agent 与子 Agent 共享 rootSessionKey）
 */
type AgentEventInstanceMeta = {
  readonly instanceId?: string
  readonly rootSessionKey?: string
}

// ============================================================
// Agent 消息事件
// ============================================================

interface AgentMessageStartEvent {
  readonly type: 'agent:message:start'
  readonly runId: string
  readonly sessionKey: string
  readonly messageId: string
  readonly model: string
  readonly timestamp: number
}

export interface AgentMessageDeltaEvent {
  readonly type: 'agent:message:delta'
  readonly runId: string
  readonly messageId: string
  /** 该流所属实例的 sessionKey（子 Agent 与 rootSessionKey 不同） */
  readonly sessionKey?: string
  /** 增量文本片段（非累积，每次只包含新增部分） */
  readonly delta: string
  /** 当前累积文本的完整长度（用于校验） */
  readonly totalLength: number
}

export interface AgentMessageEndEvent {
  readonly type: 'agent:message:end'
  readonly runId: string
  readonly messageId: string
  /** 该条消息所属实例的 sessionKey */
  readonly sessionKey?: string
  /** 完整最终文本 */
  readonly content: readonly ContentBlock[]
  readonly usage: TokenUsage
  readonly stopReason:
    | 'end_turn'
    | 'tool_use'
    | 'max_tokens'
    | 'stop_sequence'
    | 'error'
    | 'aborted'
  /** LLM 网关 HTTP/SSE 错误（与成功响应互斥） */
  readonly llmError?: GatewayLlmErrorDetail
  /**
   * 本轮注入到 system prompt 的热记忆（本地 Agent Runtime，用于「基于您的偏好」提示）
   */
  readonly injectedMemories?: readonly {
    readonly id: string
    readonly content: string
    readonly category: string
  }[]
  /** 推理内容（DeepSeek inline think / extended thinking），与 agent:thinking:end 同步携带，避免批处理顺序问题 */
  readonly thinkingText?: string
}

// ============================================================
// Agent 思考事件
// ============================================================

interface AgentThinkingDeltaEvent {
  readonly type: 'agent:thinking:delta'
  readonly runId: string
  readonly sessionKey?: string
  readonly delta: string
}

interface AgentThinkingEndEvent {
  readonly type: 'agent:thinking:end'
  readonly runId: string
  readonly sessionKey?: string
  readonly thinkingText: string
}

// ============================================================
// 工具执行事件
// ============================================================

interface AgentToolStartEvent {
  readonly type: 'agent:tool:start'
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly timestamp: number
  /** 工具调用开始时已输出的正文字符数（服务端/主进程注入，用于交错渲染定位） */
  readonly textPositionAtStart?: number
}

interface AgentToolProgressEvent {
  readonly type: 'agent:tool:progress'
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  /** 部分结果（如流式命令输出） */
  readonly partialResult?: string
  /** 进度描述 */
  readonly progressText?: string
}

interface AgentToolEndEvent {
  readonly type: 'agent:tool:end'
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly result: unknown
  readonly isError: boolean
  readonly durationMs: number
}

// ============================================================
// 回合生命周期事件
// ============================================================

interface AgentTurnStartEvent {
  readonly type: 'agent:turn:start'
  readonly runId: string
  readonly sessionKey: string
  readonly turnIndex: number
  readonly timestamp: number
}

interface AgentTurnEndEvent {
  readonly type: 'agent:turn:end'
  readonly runId: string
  readonly sessionKey: string
  readonly turnIndex: number
  readonly totalToolUseCount: number
  readonly totalTokens: number
  readonly durationMs: number
  /** 循环检测触发硬打断时为 true，UI 应展示提示 */
  readonly loopInterrupted?: true
}

/** 一轮 Agent 执行完成后检测到的工作区净文件变更。 */
interface AgentTurnFileChangesEvent {
  readonly type: 'agent:turn:file-changes'
  readonly runId: string
  readonly sessionKey: string
  readonly messageId: string
  readonly fileChanges: readonly FileChangeEntry[]
}

// ============================================================
// 状态事件
// ============================================================

export interface AgentIdleEvent {
  readonly type: 'agent:idle'
  readonly runId: string
  readonly sessionKey: string
}

/**
 * 插话已被注入对话（工具批已收尾、下一轮 provider 请求即将开始）。
 *
 * 渲染层据此把该会话里「等待注入」的插话气泡转成普通插话。
 * 为什么不需要带具体消息 id：`steeringMode: 'all'` 下同一次投递会把排队中的插话**一起**注入，
 * 所以「收到本事件 → 该会话所有待注入插话都已生效」是成立的。
 */
interface AgentSteerDeliveredEvent {
  readonly type: 'steer:delivered'
  readonly runId: string
  readonly sessionKey: string
}

export interface AgentErrorEvent {
  readonly type: 'agent:error'
  readonly runId: string
  readonly sessionKey: string
  readonly errorCode: string
  readonly errorMessage: string
  readonly isRetryable: boolean
}

interface AgentAbortEvent {
  readonly type: 'agent:abort'
  readonly runId: string
  readonly sessionKey: string
  readonly reason: 'user_cancel' | 'timeout' | 'error'
}

/** LLM 路由遥测（降级 / HTTP 错误），供 UI 模型状态指示与开发者面板 */
type AgentLlmDiagnosticEvent = {
  readonly type: 'agent:llm:diagnostic'
  readonly runId: string
  readonly sessionKey: string
} & (
  | { readonly kind: 'fallback'; readonly fromModelId: string; readonly toModelId: string; readonly reason: string }
  | { readonly kind: 'http_error'; readonly status: number; readonly code: string; readonly retryable: boolean }
)

// ============================================================
// 权限请求事件
// ============================================================

interface AgentPermissionRequestEvent {
  readonly type: 'agent:permission:request'
  readonly requestId: string
  readonly runId: string
  readonly toolName: string
  readonly toolArgs: Record<string, unknown>
  readonly riskLevel: 'low' | 'medium' | 'high'
  readonly description: string
  readonly timeoutMs: number
  /**
   * 这条请求**已经被自动审批放行了**（主进程侧 `isAutoApproveEnabled`）。
   *
   * 事件照发（审计与"刚自动放行了什么"要看），但**消费方不该拿它去叫人**：
   * 实测自动放行路径上 `request → granted` 只隔 **3 毫秒**，宠物通知（R6）
   * 刚产生就销了账——气泡压根没机会冒出来，**而系统通知已经弹出去收不回了**。
   * 用户开着自动审批时，那等于每次调受审工具都白弹一条「需要你确认」。
   */
  readonly autoApproved?: boolean
}

/**
 * 审批有结果后广播（用户响应 / 超时 / 自动放行 / 停止时的批量拒绝）。
 *
 * **为什么需要**：消费方靠它把 `waiting` 解除 —— 宠物多会话记账
 * （`renderer/pet/utils/session-activity.ts` 的 WAITING_RESOLVED_EVENTS）与
 * pet-core 的 L1 活动状态机都按这族事件设计。但此前只有 `request` 有发送者，
 * 解除类事件全仓零产出，waiting 只能靠 `tool:start`（pet-core 的防御分支）
 * 或等到 `turn:end` 兜底。症状：自动放行时后台会话每次调受审工具都会让宠物
 * 头顶挂一会儿「另一个会话在等你确认」——**误报**（实测见
 * `verify/pet-sprite/check-foreign-attention.mjs`）。
 *
 * ⚠️ 超时当前走 `denied`（`PermissionController` 超时即按 deny 处理），
 * 所以 `timeout` 暂时没有发送者；要区分时先让 controller 把超时标记传出来。
 */
interface AgentPermissionResolvedEvent {
  readonly type: 'agent:permission:granted' | 'agent:permission:denied' | 'agent:permission:timeout'
  readonly requestId: string
  readonly toolName?: string
}

// ============================================================
// ask_user_question — Agent 向用户结构化提问事件
// ============================================================

/**
 * Agent 调用 ask_user_question 工具时，主进程推送到渲染进程，
 * 渲染进程显示 Modal，用户提交后通过 `user:ask-user:respond` 命令回传。
 */
interface AgentAskUserRequestEvent {
  readonly type: 'agent:ask-user:request'
  readonly requestId: string
  readonly instanceId?: string
  /** 对话根 sessionKey，用于跨会话路由 Modal（渠道会话与当前 UI 会话不一致时） */
  readonly rootSessionKey?: string
  /** 提问的前因后果（为什么问、查到什么、答了影响什么）；渲染在弹窗标题下方 */
  readonly context?: string
  readonly questions: readonly {
    readonly question: string
    readonly header: string
    readonly multiSelect?: boolean
    readonly options: readonly {
      readonly label: string
      readonly description: string
      readonly preview?: string
      /** AI 推荐项标记（UI 高亮；每问至多一个） */
      readonly recommended?: boolean
      /** 推荐理由（一句话，配合 recommended 使用） */
      readonly recommendReason?: string
    }[]
  }[]
  readonly timeoutMs: number
}

/**
 * 主进程在超时或取消时通知渲染进程关闭 Modal。
 */
interface AgentAskUserCancelledEvent {
  readonly type: 'agent:ask-user:cancelled'
  readonly requestId: string
  /** 对话根 sessionKey，用于跨会话清除 pendingAskUser */
  readonly rootSessionKey?: string
  readonly reason: 'timeout' | 'aborted' | 'superseded'
}

// ============================================================
// 会话事件
// ============================================================

interface ConversationCreatedEvent {
  readonly type: 'conversation:created'
  readonly sessionKey: string
  readonly title: string
  readonly createdAt: number
}

interface ConversationUpdatedEvent {
  readonly type: 'conversation:updated'
  readonly sessionKey: string
  readonly title?: string
  readonly lastMessageAt?: number
}

/** 外部通道（如微信 /new 命令）触发的会话导航事件：通知客户端切换到指定会话 */
interface ConversationNavigateEvent {
  readonly type: 'conversation:navigate'
  readonly sessionKey: string
  readonly title?: string
}

export interface ConversationMessageNewEvent {
  readonly type: 'conversation:message:new'
  readonly sessionKey: string
  readonly message: {
    readonly id: string
    readonly role: 'user' | 'assistant'
    readonly content: readonly ContentBlock[]
    readonly timestamp: number
    /** 是否为语音识别消息（影响气泡图标样式） */
    readonly isVoice?: boolean
    /**
     * 是否为「中途插话」（Agent 运行途中注入的用户消息）。
     * 气泡据此加标记——插话是插进正在跑的回合里，不是新起一轮对话。
     */
    readonly isSteer?: boolean
    /** 原始录音 WAV base64，用于气泡点击回放 */
    readonly audioWavBase64?: string
    readonly toolCalls?: readonly {
      readonly id: string
      readonly name: string
      readonly args: Record<string, unknown>
      readonly result?: unknown
      readonly isError?: boolean
    }[]
  }
}

// ============================================================
// 多 Agent 活动
// ============================================================

/** 同一对话下当前活动实例列表（主进程推送） */
interface AgentActivitySnapshotEvent {
  readonly type: 'agent:activity:snapshot'
  readonly rootSessionKey: string
  readonly agents: readonly {
    readonly instanceId: string
    readonly name: string
    readonly state: string
    readonly isSubAgent: boolean
    /** 子 Agent 运行模式（可选，向后兼容） */
    readonly mode?: 'sync' | 'async'
    /** broker 运行状态（可选） */
    readonly status?: string
    readonly startedAt?: number
    readonly lastProgressAt?: number
  }[]
}

/** 异步子 Agent 完成通知（投递前推送，供 UI / 监控） */
export interface AgentSubagentCompletedEvent {
  readonly type: 'agent:subagent:completed'
  readonly parentInstanceId: string
  readonly childInstanceId: string
  readonly name: string
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'stale'
  /** 截断到约 200 字供 UI 预览 */
  readonly summaryPreview: string
  /** 父实例所在会话：完成结果汇入的会话，供 UI 路由与「是否正在看该会话」判断 */
  readonly sessionKey?: string
}

// ============================================================
// 上下文使用量事件
// ============================================================

/**
 * Agent 上下文使用量更新事件（每轮 message:end 后由 bridge 计算并推送）
 *
 * 用于 ChatInput 工具栏显示上下文指示器（绿/黄/红）。
 */
/** 上下文占用分类（与 UI 卡片行一一对应） */
export type ContextUsageCategory =
  | 'systemPrompt'
  | 'tools'
  | 'skills'
  | 'mcp'
  | 'subagents'
  | 'memory'
  | 'dynamicContext'
  | 'conversation'

/** 单个分类的 token 占用 */
export interface ContextUsageBreakdownEntry {
  readonly category: ContextUsageCategory
  readonly tokens: number
}

/**
 * 触发线快照。
 *
 * 压缩判断比的不是整窗百分比，而是「对话历史 vs 留给对话的空间 × 阈值比例」——
 * 固定开销（系统提示/工具/MCP）挤占窗口时，整窗到 78% 未必压缩、对话占满预算
 * 的 78% 才压缩。判据与来历见 `shared/context-budget.ts` 的模块注释。
 */
export interface ContextBudgetSnapshot {
  /** 当前对话历史占用（可压缩量） */
  readonly compressibleTokens: number
  /** 留给对话历史的空间：窗口 − 固定开销 − 输出预留 */
  readonly budgetTokens: number
  /** 触发自动压缩的对话历史 token 线 = floor(budgetTokens × triggerThreshold) */
  readonly triggerTokens: number
  /** 固定开销已挤满窗口，压缩无法释放 */
  readonly exhausted: boolean
}

export interface AgentContextUsageEvent {
  readonly type: 'agent:context:usage'
  readonly sessionKey: string
  /** 当前已使用的 token 数（inputTokens + cacheRead + cacheWrite，不是只取 inputTokens） */
  readonly usedTokens: number
  /** 模型上下文窗口总大小 */
  readonly contextWindow: number
  /** 触发自动压缩的阈值比例（0-1），取值见 DEFAULT_COMPACTION_TRIGGER_RATIO */
  readonly triggerThreshold: number
  /** 分类明细（固定提示词、动态上下文和对话历史分别估算） */
  readonly breakdown?: readonly ContextUsageBreakdownEntry[]
  /** 触发线快照；轻量推送（不带 breakdown 的逐往返刷新）时省略 */
  readonly budget?: ContextBudgetSnapshot
}

/**
 * 上下文压缩完成事件（手动或自动压缩后由 bridge 推送）
 */
interface AgentContextCompactedEvent {
  readonly type: 'agent:context:compacted'
  readonly sessionKey: string
  /** 压缩前整窗占用（含系统提示/工具/MCP，与占用卡片同一口径） */
  readonly previousTokenCount: number
  /** 压缩后整窗占用（只扣对话历史，MCP 定义不变） */
  readonly newTokenCount: number
  readonly messagesRemoved: number
  readonly timestamp: number
  /** 压缩前消息条数（精确值，非估算） */
  readonly messagesBefore?: number
  /** 压缩后消息条数（精确值，非估算） */
  readonly messagesAfter?: number
  /** LLM 摘要正文，供压缩卡片展开查看 */
  readonly summaryText?: string
  /** 压缩后的分类明细（对话已缩小，其余分类保持） */
  readonly breakdown?: readonly ContextUsageBreakdownEntry[]
  /** 压缩前对话历史估算（不含 MCP/工具定义） */
  readonly conversationTokensBefore?: number
  /** 压缩后对话历史估算 */
  readonly conversationTokensAfter?: number
  /**
   * 本次压缩采用的策略。
   * - "summary"：LLM 全历史摘要（对话流展示压缩卡片）
   * - "micro" / "hard-trim"：确定性静默清理（不展示卡片，仅更新占用条）
   */
  readonly strategy?: 'micro' | 'summary' | 'hard-trim' | 'none'
  /**
   * 所属请求 runId（自动压缩由 bridge 注入）。
   * 同一 run 内的多次压缩由渲染端合并为一张卡片，避免一次请求刷屏。
   */
  readonly runId?: string
}

// ============================================================
// 文件相关事件
// ============================================================

/** Agent 生成文件后（或跨通道收到文件）主进程推送到渲染进程 */
interface AgentFileCreatedEvent {
  readonly type: 'agent:file:created'
  readonly fileId: string
  readonly fileName: string
  /** 相对于客户端数据根目录的路径 */
  readonly localPath: string
  readonly mimeType: string | null
  readonly fileSize: number | null
  readonly conversationId: string | null
  readonly messageId: string | null
  readonly agentId: string | null
  readonly channel: string
  readonly category: 'upload' | 'output'
}

/** Bridge 初始化完成后推送到渲染进程，触发历史会话加载 */
interface AgentRuntimeReadyEvent {
  readonly type: 'runtime:ready'
  readonly timestamp: number
}

// ── 客户端命令工具事件（Agent 主动调用工具时推送到渲染进程） ──

interface SessionCreateRequestEvent { readonly type: 'session:create-request' }
interface SessionClearedEvent { readonly type: 'session:cleared'; readonly sessionKey: string }
interface SessionCompactRequestEvent { readonly type: 'session:compact-request'; readonly sessionKey: string; readonly keepRecentTurns: number }
interface SessionSwitchRequestEvent { readonly type: 'session:switch-request'; readonly sessionKey: string }
interface SettingsThinkLevelEvent { readonly type: 'settings:think-level'; readonly level: string }
interface SettingsBackendChangedEvent { readonly type: 'settings:backend-changed'; readonly backendId: string }

/** Agent 团队生成完成（渲染进程刷新 Agent 列表） */
interface AgentTeamGeneratedEvent {
  readonly type: 'agent:team:generated'
  readonly agents: readonly { readonly name: string; readonly agentId?: string; readonly ok: boolean; readonly error?: string }[]
}

/** Agent 团队优化完成（渲染进程刷新 Agent 列表） */
interface AgentTeamOptimizedEvent {
  readonly type: 'agent:team:optimized'
  readonly agentIds: readonly string[]
}

/** 自定义 Agent 已删除（渲染进程刷新 Agent 列表） */
interface AgentRemovedEvent {
  readonly type: 'agent:removed'
  readonly agentId: string
}

// ============================================================
// 技能自进化事件
// ============================================================

/** 技能草稿已生成，等待用户确认 */
interface SkillDraftReadyEvent {
  readonly type: 'skill:draft_ready'
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

/** 技能改进方案已生成，等待用户确认 */
interface SkillImprovementReadyEvent {
  readonly type: 'skill:improvement_ready'
  readonly skillName: string
  readonly naturalLanguageDiff: string
}

/** 建议废弃技能 */
interface SkillDeprecationSuggestedEvent {
  readonly type: 'skill:deprecation_suggested'
  readonly skillName: string
  readonly humanTitle: string
}

/**
 * 自主进化 Mood 变化 → 桌宠实时表情。
 *
 * `mood` 是 2026-09-23 补的三维载荷：宠物要按心情调呼吸幅度/活动频率，
 * 光有 4 值表情键不够。**字段可选**，只读 `emotion` 的老消费者（PetOrchestrator /
 * PetModeShell）不受影响；三维也**不直接展示给用户**（设计 11 §11 禁令），只喂给程序化动画。
 *
 * ⚠ **`agentId` 是第四期 T4.4 补的，必填**：在这之前这条事件不带归属，于是宠物窗把
 * **助手的**心情当成了自己的脸——`recordMoodEvent` 的默认 agentId 就是 `assistant`，
 * 而它当时是全仓唯一的生产者。宠物是独立 Agent（设计 §3.7），情绪必须分得开。
 *
 * 必填而不是可选：可选会让"忘了带 agentId"退化成"渲染层猜"，而猜错的形态是
 * **宠物为助手的情绪雀跃或沮丧**——不报错、日志里也看不出，只能靠用户觉得别扭。
 * 唯一的生产者是 `bridge.recordMoodEvent`，漏传会当场编译不过。
 */
interface AutonomousMoodEmotionEvent {
  readonly type: 'autonomous:mood:emotion'
  /** 这份心情是谁的：`assistant` 或 `pet:<模型ID>`。渲染层按它决定要不要采纳 */
  readonly agentId: string
  readonly emotion: 'joy' | 'sadness' | 'surprise' | 'neutral'
  readonly mood?: {
    readonly energy: number // 0..1
    readonly valence: number // -1..1
    readonly arousal: number // 0..1
  }
}

/**
 * 宠物做完了一件事（`pet:goal:result`，三期 T3.5）。
 *
 * 用户交代给宠物的目标跑完之后由主进程推这一条，宠物窗把它折成一条 `report` 档通知：
 * **气泡说出来 + 控制坞留一行**，30 秒自清。这是宠物唯一的播报通道。
 *
 * ⚠ **它刻意不进系统通知**（计划 §五 的 P3 断言）：宠物报的是一句"我看到了什么"，
 * 和桌面弹窗不是一回事；同一件事既冒气泡又弹系统通知就是重复打扰。
 * 主进程侧因此**不许**调 `showCronNotification` —— 有一条守卫测试盯着这件事。
 *
 * `text` 是**已经可以直接展示的文案**（成句是宿主的事）：成功时是宠物报的结果，
 * 失败时是原因。pet-core 只负责把它放进气泡，不理解内容。
 */
export interface PetGoalResultEvent {
  readonly type: 'pet:goal:result'
  /** 宠物自己的会话（`evolution:pet:<模型ID>`）：气泡归属与限流都按它算 */
  readonly sessionKey: string
  /** 归属宠物（`pet:<模型ID>`），供 UI 区分是哪一只 */
  readonly petAgentId: string
  /**
   * 这条回执是哪一个目标产生的（`autonomous_goals.id`）。
   *
   * 气泡的幂等键靠它，**不能靠文案**：失败文案在没有正文时是个常量
   * （「这次没做成」），拿文案哈希当键会让第二次失败被当成重放挡掉——
   * 宠物连栽两次，用户只听见第一次（2026-09-24 复查发现）。
   */
  readonly goalId: string
  readonly ok: boolean
  readonly text: string
}

/**
 * 宠物感知到你怎么样了（`pet:sensing`，四期 T4.2 / T4.3）。
 *
 * 「要不要歇会儿」「你在弄『X』，两个多小时了」这类话走这一条。与 `PetGoalResultEvent`
 * 的两处不同，都是刻意的：
 *
 * - **`sessionKey` 是「你」在用的会话**，不是宠物自己的会话——它是看着你干活说的，
 *   点气泡应该跳回你刚才那条对话。宠物目标那条反过来（那是它自己的活）。
 * - **没有 `ok`**：感知类的话没有成败可言。设计 §4.1.5 第 3 条要求它**只走气泡**，
 *   所以它也不该带任何"要不要处置"的语义。
 *
 * `text` 同样是**已经可以直接展示的文案**（成句是宿主的事，见 `pet-sensing.ts` 的文案段）。
 * 宠物对沉淀的读取是**只读**的（设计 §4.1.4 权限边界）：本事件不携带任何记忆原文，
 * 只带成句后的那一句话。
 */
export interface PetSensingEvent {
  readonly type: 'pet:sensing'
  /**
   * **说这句话的宠物**（`pet:<模型ID>`）。
   *
   * 2026-09-24 补：这个事件原先只有用户的 `sessionKey`（气泡落点），没有归属。
   * 单宠物时看不出来，但"换模型 = 换宠物"是既有口径（`petAgentId(configId)`）——
   * 多宠物同屏时，没有这个字段就无法分辨这句话是谁说的。
   * 与 `PetGoalResultEvent.petAgentId` 同名同义。
   */
  readonly petAgentId: string
  /** 用户当前在用的会话（气泡落点） */
  readonly sessionKey: string
  readonly text: string
  /** 哪条预判规则说的（`interrupted` / `tired`）——控制坞与日志据此分辨 */
  readonly kind: string
  /**
   * 这句话附带的一件可派的事（五期 T5.1②，设计 §4.2.1 的意图来源②）。
   *
   * 有它时气泡上那个按钮的含义就变了：不是"回到那个会话"（`noticeActionLabel` 的默认），
   * 而是**"让我去看看"**——点一下真的派出一个宠物目标。
   *
   * 只在说得出一件具体的事时才有（规则① + 读到了工作主题，见 `pet-sensing.ts`
   * 的 `proposalFor`）。说不出就不给这个出口：一个没有"看什么"的按钮，
   * 按下去只能瞎翻，回来报一句废话——用户按了一次就不会再按第二次。
   */
  readonly proposal?: { readonly description: string }
}

// ============================================================
// 联合类型
// ============================================================
/** 所有 Agent Runtime 事件的联合类型 */
export type AgentRuntimeEvent =
  | (AgentMessageStartEvent & AgentEventInstanceMeta)
  | (AgentMessageDeltaEvent & AgentEventInstanceMeta)
  | (AgentMessageEndEvent & AgentEventInstanceMeta)
  | (AgentThinkingDeltaEvent & AgentEventInstanceMeta)
  | (AgentThinkingEndEvent & AgentEventInstanceMeta)
  | (AgentToolStartEvent & AgentEventInstanceMeta)
  | (AgentToolProgressEvent & AgentEventInstanceMeta)
  | (AgentToolEndEvent & AgentEventInstanceMeta)
  | (AgentTurnStartEvent & AgentEventInstanceMeta)
  | (AgentTurnEndEvent & AgentEventInstanceMeta)
  | (AgentTurnFileChangesEvent & AgentEventInstanceMeta)
  | (AgentIdleEvent & AgentEventInstanceMeta)
  | (AgentSteerDeliveredEvent & AgentEventInstanceMeta)
  | (AgentErrorEvent & AgentEventInstanceMeta)
  | (AgentAbortEvent & AgentEventInstanceMeta)
  | (AgentLlmDiagnosticEvent & AgentEventInstanceMeta)
  | (AgentPermissionRequestEvent & AgentEventInstanceMeta)
  | (AgentPermissionResolvedEvent & AgentEventInstanceMeta)
  | AgentAskUserRequestEvent
  | AgentAskUserCancelledEvent
  | ConversationCreatedEvent
  | ConversationUpdatedEvent
  | ConversationNavigateEvent
  | ConversationMessageNewEvent
  | AgentActivitySnapshotEvent
  | AgentSubagentCompletedEvent
  | AgentContextUsageEvent
  | AgentContextCompactedEvent
  | AgentFileCreatedEvent
  | AgentRuntimeReadyEvent
  | SessionCreateRequestEvent
  | SessionClearedEvent
  | SessionCompactRequestEvent
  | SessionSwitchRequestEvent
  | SettingsThinkLevelEvent
  | SettingsBackendChangedEvent
  | AgentTeamGeneratedEvent
  | AgentTeamOptimizedEvent
  | AgentRemovedEvent
  | SkillDraftReadyEvent
  | SkillImprovementReadyEvent
  | SkillDeprecationSuggestedEvent
  | AutonomousMoodEmotionEvent
  | PetGoalResultEvent
  | PetSensingEvent

/** 所有事件类型字面量 */
export type AgentRuntimeEventType = AgentRuntimeEvent['type']
