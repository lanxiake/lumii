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
export interface GatewayLlmErrorDetail {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly httpStatus?: number
}

/**
 * 多 Agent：来源实例与对话聚合键（主 Agent 与子 Agent 共享 rootSessionKey）
 */
export type AgentEventInstanceMeta = {
  readonly instanceId?: string
  readonly rootSessionKey?: string
}

// ============================================================
// Agent 消息事件
// ============================================================

export interface AgentMessageStartEvent {
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

export interface AgentThinkingDeltaEvent {
  readonly type: 'agent:thinking:delta'
  readonly runId: string
  readonly sessionKey?: string
  readonly delta: string
}

export interface AgentThinkingEndEvent {
  readonly type: 'agent:thinking:end'
  readonly runId: string
  readonly sessionKey?: string
  readonly thinkingText: string
}

// ============================================================
// 工具执行事件
// ============================================================

export interface AgentToolStartEvent {
  readonly type: 'agent:tool:start'
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly timestamp: number
  /** 工具调用开始时已输出的正文字符数（服务端/主进程注入，用于交错渲染定位） */
  readonly textPositionAtStart?: number
}

export interface AgentToolProgressEvent {
  readonly type: 'agent:tool:progress'
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  /** 部分结果（如流式命令输出） */
  readonly partialResult?: string
  /** 进度描述 */
  readonly progressText?: string
}

export interface AgentToolEndEvent {
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

export interface AgentTurnStartEvent {
  readonly type: 'agent:turn:start'
  readonly runId: string
  readonly sessionKey: string
  readonly turnIndex: number
  readonly timestamp: number
}

export interface AgentTurnEndEvent {
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
export interface AgentTurnFileChangesEvent {
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

export interface AgentErrorEvent {
  readonly type: 'agent:error'
  readonly runId: string
  readonly sessionKey: string
  readonly errorCode: string
  readonly errorMessage: string
  readonly isRetryable: boolean
}

export interface AgentAbortEvent {
  readonly type: 'agent:abort'
  readonly runId: string
  readonly sessionKey: string
  readonly reason: 'user_cancel' | 'timeout' | 'error'
}

/** LLM 路由遥测（降级 / HTTP 错误），供 UI 模型状态指示与开发者面板 */
export type AgentLlmDiagnosticEvent = {
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

export interface AgentPermissionRequestEvent {
  readonly type: 'agent:permission:request'
  readonly requestId: string
  readonly runId: string
  readonly toolName: string
  readonly toolArgs: Record<string, unknown>
  readonly riskLevel: 'low' | 'medium' | 'high'
  readonly description: string
  readonly timeoutMs: number
}

// ============================================================
// ask_user_question — Agent 向用户结构化提问事件
// ============================================================

/**
 * Agent 调用 ask_user_question 工具时，主进程推送到渲染进程，
 * 渲染进程显示 Modal，用户提交后通过 `user:ask-user:respond` 命令回传。
 */
export interface AgentAskUserRequestEvent {
  readonly type: 'agent:ask-user:request'
  readonly requestId: string
  readonly instanceId?: string
  readonly questions: readonly {
    readonly question: string
    readonly header: string
    readonly multiSelect?: boolean
    readonly options: readonly {
      readonly label: string
      readonly description: string
      readonly preview?: string
    }[]
  }[]
  readonly timeoutMs: number
}

/**
 * 主进程在超时或取消时通知渲染进程关闭 Modal。
 */
export interface AgentAskUserCancelledEvent {
  readonly type: 'agent:ask-user:cancelled'
  readonly requestId: string
  readonly reason: 'timeout' | 'aborted' | 'superseded'
}

// ============================================================
// 会话事件
// ============================================================

export interface ConversationCreatedEvent {
  readonly type: 'conversation:created'
  readonly sessionKey: string
  readonly title: string
  readonly createdAt: number
}

export interface ConversationUpdatedEvent {
  readonly type: 'conversation:updated'
  readonly sessionKey: string
  readonly title?: string
  readonly lastMessageAt?: number
}

/** 外部通道（如微信 /new 命令）触发的会话导航事件：通知客户端切换到指定会话 */
export interface ConversationNavigateEvent {
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
export interface AgentActivitySnapshotEvent {
  readonly type: 'agent:activity:snapshot'
  readonly rootSessionKey: string
  readonly agents: readonly {
    readonly instanceId: string
    readonly name: string
    readonly state: string
    readonly isSubAgent: boolean
  }[]
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
  | 'conversation'

/** 单个分类的 token 占用 */
export interface ContextUsageBreakdownEntry {
  readonly category: ContextUsageCategory
  readonly tokens: number
}

export interface AgentContextUsageEvent {
  readonly type: 'agent:context:usage'
  readonly sessionKey: string
  /** 当前已使用的 token 数（累计 inputTokens） */
  readonly usedTokens: number
  /** 模型上下文窗口总大小 */
  readonly contextWindow: number
  /** 触发自动压缩的阈值比例（0-1，默认 0.8） */
  readonly triggerThreshold: number
  /** 分类明细（估算后按 usedTokens 等比缩放，之和≈usedTokens），无活跃实例时为空 */
  readonly breakdown?: readonly ContextUsageBreakdownEntry[]
}

/**
 * 上下文压缩完成事件（手动或自动压缩后由 bridge 推送）
 */
export interface AgentContextCompactedEvent {
  readonly type: 'agent:context:compacted'
  readonly sessionKey: string
  readonly previousTokenCount: number
  readonly newTokenCount: number
  readonly messagesRemoved: number
  readonly timestamp: number
  /** 压缩前消息条数（精确值，非估算） */
  readonly messagesBefore?: number
  /** 压缩后消息条数（精确值，非估算） */
  readonly messagesAfter?: number
}

// ============================================================
// 文件相关事件
// ============================================================

/** Agent 生成文件后（或跨通道收到文件）主进程推送到渲染进程 */
export interface AgentFileCreatedEvent {
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
export interface AgentRuntimeReadyEvent {
  readonly type: 'runtime:ready'
  readonly timestamp: number
}

// ── 客户端命令工具事件（Agent 主动调用工具时推送到渲染进程） ──

export interface SessionCreateRequestEvent { readonly type: 'session:create-request' }
export interface SessionClearedEvent { readonly type: 'session:cleared'; readonly sessionKey: string }
export interface SessionCompactRequestEvent { readonly type: 'session:compact-request'; readonly sessionKey: string; readonly keepRecentTurns: number }
export interface SessionSwitchRequestEvent { readonly type: 'session:switch-request'; readonly sessionKey: string }
export interface SettingsThinkLevelEvent { readonly type: 'settings:think-level'; readonly level: string }
export interface SettingsBackendChangedEvent { readonly type: 'settings:backend-changed'; readonly backendId: string }

/** Agent 团队生成完成（渲染进程刷新 Agent 列表） */
export interface AgentTeamGeneratedEvent {
  readonly type: 'agent:team:generated'
  readonly agents: readonly { readonly name: string; readonly agentId?: string; readonly ok: boolean; readonly error?: string }[]
}

/** Agent 团队优化完成（渲染进程刷新 Agent 列表） */
export interface AgentTeamOptimizedEvent {
  readonly type: 'agent:team:optimized'
  readonly agentIds: readonly string[]
}

/** 自定义 Agent 已删除（渲染进程刷新 Agent 列表） */
export interface AgentRemovedEvent {
  readonly type: 'agent:removed'
  readonly agentId: string
}

// ============================================================
// 技能自进化事件
// ============================================================

/** 技能草稿已生成，等待用户确认 */
export interface SkillDraftReadyEvent {
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
export interface SkillImprovementReadyEvent {
  readonly type: 'skill:improvement_ready'
  readonly skillName: string
  readonly naturalLanguageDiff: string
}

/** 建议废弃技能 */
export interface SkillDeprecationSuggestedEvent {
  readonly type: 'skill:deprecation_suggested'
  readonly skillName: string
  readonly humanTitle: string
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
  | (AgentErrorEvent & AgentEventInstanceMeta)
  | (AgentAbortEvent & AgentEventInstanceMeta)
  | (AgentLlmDiagnosticEvent & AgentEventInstanceMeta)
  | (AgentPermissionRequestEvent & AgentEventInstanceMeta)
  | AgentAskUserRequestEvent
  | AgentAskUserCancelledEvent
  | ConversationCreatedEvent
  | ConversationUpdatedEvent
  | ConversationNavigateEvent
  | ConversationMessageNewEvent
  | AgentActivitySnapshotEvent
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

/** 所有事件类型字面量 */
export type AgentRuntimeEventType = AgentRuntimeEvent['type']
