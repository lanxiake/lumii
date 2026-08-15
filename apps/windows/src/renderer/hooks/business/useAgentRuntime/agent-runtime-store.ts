/**
 * Agent Runtime Store — 多会话并行架构
 *
 * 参考 Claude Code 的 store.ts 模式：
 * - 使用外部 Store（非 React 内部 state）管理运行时状态
 * - 通过 useSyncExternalStore 订阅切片
 * - Delta 拼接不触发全量 re-render
 * - 每个会话独立维护状态（PerSessionState），通过 sessions Map 管理
 *
 * 设计依据: .qoder/design/client-agent-runtime/08-前端渲染与IPC通讯.md §5/§8
 */

import type {
  AgentRuntimeEvent,
  ContentBlock,
  ContextUsageBreakdownEntry,
  TokenUsage,
} from '../../../../shared/agent-runtime-events'
import type { AssistantPart, FileChangeEntry } from '@mtbot/agent-runtime/browser'

// ============================================================
// 状态类型定义
// ============================================================

/** 单条助手消息的流式统计（用于 UI 展示速度/耗时） */
export interface StreamMetrics {
  /** 从首字到结束的近似耗时（ms） */
  readonly durationMs: number
  /** 输出 token 平均速度（token/s），来自 usage */
  readonly tokensPerSecond: number
}

/** 一条对话消息 */
export interface RuntimeMessage {
  readonly id: string
  /** system 仅用于客户端本地注入的命令反馈消息，不发给 LLM、不持久化 */
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: readonly ContentBlock[]
  /** 助手消息的结构化时间线；用户和 system 消息使用空数组 */
  readonly parts: readonly AssistantPart[]
  /** 本轮助手回复关联的工作区净文件变更 */
  readonly fileChanges?: readonly FileChangeEntry[]
  readonly timestamp: number
  readonly isStreaming: boolean
  /**
   * 已被上下文压缩移出 LLM 请求，但仍保留在历史记录中（用户可回看）。
   */
  readonly contextExcluded?: boolean
  /** 是否为语音识别消息（用户通过语音通话输入的消息） */
  readonly isVoice?: boolean
  /** 原始录音 WAV base64，用于气泡点击回放 */
  readonly audioWavBase64?: string
  readonly toolCalls: readonly RuntimeToolCall[]
  /**
   * 所属 agent turn 的 runId（主 Agent 消息专用）。
   * 同一个 turn 内多次 LLM 调用共享同一个 turnId，用于判断是否可以复用消息气泡。
   */
  readonly turnId?: string
  /** 子 Agent 回复：用于嵌套气泡样式 */
  readonly sourceAgent?: {
    readonly instanceId: string
    readonly label: string
  }
  /** 子 Agent 块是否折叠（仅 sourceAgent 存在时有效） */
  readonly subAgentCollapsed?: boolean
  /** ACP 后端标识（如 Cursor / Claude Code），仅本机 CLI 后端回复时存在 */
  readonly acpBackendLabel?: string
  readonly thinkingText?: string
  readonly usage?: TokenUsage
  /** 流式可视化指标（message:end 时写入） */
  readonly streamMetrics?: StreamMetrics
  /** 结构化 LLM 错误（与 llmError 二选一展示） */
  readonly llmError?: { readonly code: string; readonly message: string; readonly retryable: boolean }
  /**
   * 本轮回复是否使用了本地热记忆（来自 IPC agent:message:end）
   */
  readonly injectedMemories?: readonly {
    readonly id: string
    readonly content: string
    readonly category: string
  }[]
}

/** 工具调用信息 */
export interface RuntimeToolCall {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
  readonly status: 'running' | 'completed' | 'error'
  readonly result?: unknown
  readonly isError: boolean
  /** 错误信息（当 isError 为 true 时） */
  readonly error?: string
  readonly progressText?: string
  readonly durationMs?: number
  /** 工具调用开始时间戳（ms，用于运行中的实时耗时显示） */
  readonly startMs?: number
  /** 工具调用结束时间戳（ms，用于历史记录展示） */
  readonly endMs?: number
  /** 工具调用开始时，当前 assistant 消息的文字字符数（用于交错渲染） */
  readonly textPositionAtStart?: number
}

/** 权限请求 */
export interface PendingPermission {
  readonly requestId: string
  readonly toolName: string
  readonly toolArgs: Record<string, unknown>
  readonly riskLevel: 'low' | 'medium' | 'high'
  readonly description: string
  readonly timeoutMs: number
  readonly receivedAt: number
}

/** ask_user_question 待回答请求（渲染侧展示 Modal 用） */
export interface PendingAskUser {
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
  readonly receivedAt: number
}

/** LLM 网关路由健康度（模型状态指示器） */
export type LlmRouteStatus = 'healthy' | 'degraded' | 'error'

/** 上下文使用量状态 */
export interface ContextUsage {
  /** 当前已使用的 token 数（累计 inputTokens） */
  readonly usedTokens: number
  /** 模型上下文窗口总大小 */
  readonly contextWindow: number
  /** 触发自动压缩的阈值比例（0-1） */
  readonly triggerThreshold: number
  /** 是否已接近阈值（usedTokens / contextWindow > 0.6） */
  readonly isNearThreshold: boolean
  /** 分类明细（主进程估算后按 usedTokens 缩放），无活跃实例时缺省 */
  readonly breakdown?: readonly ContextUsageBreakdownEntry[]
}

/** 错误状态 */
export interface ErrorState {
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
}

/** 活动 Agent */
export interface ActiveAgent {
  readonly instanceId: string
  readonly name: string
  readonly state: string
  readonly isSubAgent: boolean
}

/** 回合统计 */
export interface TurnStats {
  readonly toolUseCount: number
  readonly totalTokens: number
  readonly durationMs: number
}

/** 上下文压缩事件（渲染为聊天分隔卡片） */
export interface RuntimeCompactionEvent {
  readonly id: string
  readonly timestamp: number
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly messagesRemoved: number
  /** 压缩前消息条数（精确值，非估算） */
  readonly messagesBefore: number
  /** 压缩后消息条数（精确值，非估算） */
  readonly messagesAfter: number
  /** LLM 摘要正文，供压缩卡片展开查看 */
  readonly summaryText?: string
}

/** Agent 生成文件事件（文件附件卡片数据） */
export interface RuntimeFileEvent {
  readonly fileId: string
  readonly fileName: string
  readonly localPath: string
  readonly mimeType: string | null
  readonly fileSize: number | null
  readonly conversationId: string | null
  readonly messageId: string | null
  readonly agentId: string | null
  readonly channel: string
  readonly category: 'upload' | 'output'
}

// ============================================================
// 多会话状态结构
// ============================================================

/**
 * 单个会话的完整状态
 * 每个 sessionKey 对应独立的 PerSessionState，会话间完全隔离
 */
/**
 * 历史懒加载状态：会话历史按页从 DB 取，用户上滑时再取更早的一页。
 * 压缩不再删除消息，历史可能很长，一次性全量加载会拖垮首屏。
 */
export interface HistoryPaging {
  /** 是否还有更早的历史可加载 */
  readonly hasMore: boolean
  /** 正在加载更早的一页 */
  readonly isLoading: boolean
  /** 已加载的最早一条消息，作为下一页的游标；无历史时为 null */
  readonly cursor: { readonly timestamp: string; readonly id: string } | null
}

export interface PerSessionState {
  readonly messages: readonly RuntimeMessage[]
  /** 历史消息懒加载分页状态 */
  readonly historyPaging: HistoryPaging
  readonly isStreaming: boolean
  readonly activeRunId: string | null
  readonly currentTool: RuntimeToolCall | null
  readonly isThinking: boolean
  readonly currentThinkingText: string
  readonly pendingPermission: PendingPermission | null
  readonly pendingAskUser: PendingAskUser | null
  readonly error: ErrorState | null
  readonly turnStats: TurnStats | null
  readonly llmRouteStatus: LlmRouteStatus
  readonly llmRouteDetail: string | null
  readonly currentLlmModelId: string | null
  readonly activeAgents: readonly ActiveAgent[]
  readonly contextUsage: ContextUsage | null
  /** 上下文自动压缩进行中（ratio >= triggerThreshold 时设为 true，压缩完成后清除） */
  readonly isAutoCompacting: boolean
  /** 当前会话内 Agent 生成的文件列表（按 messageId 分组） */
  readonly fileEvents: readonly RuntimeFileEvent[]
  /** 上下文自动压缩事件列表（渲染为聊天分隔卡片） */
  readonly compactionEvents: readonly RuntimeCompactionEvent[]
  /** Agent 调用 task_complete 工具时设置，包含完成摘要和时间戳 */
  readonly lastTaskCompletion: { summary: string; timestamp: number } | null
  /**
   * 本轮 Agent 回复「正常结束」的时间戳（仅 agent:turn:end 主 Agent 正常完成时更新）。
   * 中止（agent:abort）/错误（agent:error）路径**不**更新此值，
   * 供 UI 监听其边沿变化以触发「等待队列自动发送」，避免工具调用间隙误触发。
   */
  readonly lastTurnEndAt: number | null
}

/**
 * 多会话运行时全局状态
 * sessions Map 保存所有会话的独立状态；currentSessionKey 指向 UI 当前显示的会话
 */
export interface MultiSessionRuntimeState {
  readonly sessions: Map<string, PerSessionState>
  readonly currentSessionKey: string | null
  /** bridge.initialize() 完成后由 runtime:ready 事件设为 true，触发历史会话加载 */
  readonly isReady: boolean
}

/**
 * @deprecated 使用 PerSessionState 和 MultiSessionRuntimeState 替代
 * 保留此别名以减少外部引用破坏
 */
export type AgentRuntimeState = PerSessionState

// ============================================================
// Store 实现
// ============================================================

type Listener = () => void

interface RuntimeStore {
  getState: () => MultiSessionRuntimeState
  setState: (updater: (prev: MultiSessionRuntimeState) => MultiSessionRuntimeState) => void
  subscribe: (listener: Listener) => () => void
}

/**
 * 共享空数组，保证默认快照在 useSyncExternalStore 场景下引用稳定。
 */
const EMPTY_MESSAGES: readonly RuntimeMessage[] = []
const EMPTY_ACTIVE_AGENTS: readonly ActiveAgent[] = []
const EMPTY_FILE_EVENTS: readonly RuntimeFileEvent[] = []
const EMPTY_COMPACTION_EVENTS: readonly RuntimeCompactionEvent[] = []

/** 默认分页状态：尚未从 DB 加载过，视为「无更早历史」直到首页返回 hasMore */
const DEFAULT_HISTORY_PAGING: HistoryPaging = {
  hasMore: false,
  isLoading: false,
  cursor: null,
}

/**
 * 共享默认会话状态（只读）。用于“无当前会话”或新会话初始化的基准快照，
 * 避免每次读取都返回新对象导致订阅器误判为状态变化。
 */
const DEFAULT_PER_SESSION_STATE: PerSessionState = {
  messages: EMPTY_MESSAGES,
  historyPaging: DEFAULT_HISTORY_PAGING,
  isThinking: false,
  currentThinkingText: '',
  currentTool: null,
  activeRunId: null,
  pendingPermission: null,
  pendingAskUser: null,
  error: null,
  isStreaming: false,
  turnStats: null,
  llmRouteStatus: 'healthy',
  llmRouteDetail: null,
  currentLlmModelId: null,
  activeAgents: EMPTY_ACTIVE_AGENTS,
  contextUsage: null,
  isAutoCompacting: false,
  fileEvents: EMPTY_FILE_EVENTS,
  compactionEvents: EMPTY_COMPACTION_EVENTS,
  lastTaskCompletion: null,
  lastTurnEndAt: null,
}

/**
 * 返回单个会话的默认状态
 */
export function getDefaultPerSessionState(): PerSessionState {
  return DEFAULT_PER_SESSION_STATE
}

/**
 * 返回全局多会话状态的默认值
 */
function getDefaultRuntimeState(): MultiSessionRuntimeState {
  return {
    sessions: new Map<string, PerSessionState>(),
    currentSessionKey: null,
    isReady: false,
  }
}

function createRuntimeStore(): RuntimeStore {
  let state = getDefaultRuntimeState()
  const listeners = new Set<Listener>()

  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return
      state = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** 模块级单例 Store */
export const runtimeStore = createRuntimeStore()

/**
 * 更新指定会话的状态（不可变更新）
 * 如果会话不存在，将使用默认状态作为基础进行更新
 */
export function updateSessionState(
  sessionKey: string,
  updater: (prev: PerSessionState) => PerSessionState,
): void {
  runtimeStore.setState((globalPrev) => {
    const sessionPrev = globalPrev.sessions.get(sessionKey) ?? getDefaultPerSessionState()
    const sessionNext = updater(sessionPrev)
    if (Object.is(sessionNext, sessionPrev)) return globalPrev
    const newSessions = new Map(globalPrev.sessions)
    newSessions.set(sessionKey, sessionNext)
    return { ...globalPrev, sessions: newSessions }
  })
}

/**
 * 在全部会话中查找首个待处理的权限请求。
 * 后台频道（如微信）会话与当前 UI 会话不一致时，仍需弹出确认框。
 */
export function findAnyPendingPermission(
  state: MultiSessionRuntimeState,
): { sessionKey: string; pending: PendingPermission } | null {
  for (const [sessionKey, sessionState] of state.sessions) {
    const pending = sessionState.pendingPermission
    if (pending) {
      return { sessionKey, pending }
    }
  }
  return null
}

/** useSyncExternalStore 用的稳定空快照（引用不变，避免无限重渲染） */
export interface PendingPermissionSnapshot {
  readonly sessionKey: string | null
  readonly pending: PendingPermission | null
}

const EMPTY_PENDING_PERMISSION_SNAPSHOT: PendingPermissionSnapshot = {
  sessionKey: null,
  pending: null,
}

let cachedPendingPermissionSnapshot: PendingPermissionSnapshot = EMPTY_PENDING_PERMISSION_SNAPSHOT

/**
 * 返回缓存的权限快照，仅在 requestId 或 sessionKey 变化时更新引用。
 * useSyncExternalStore 要求 getSnapshot 在数据未变时返回同一对象。
 */
export function getPendingPermissionSnapshot(): PendingPermissionSnapshot {
  const found = findAnyPendingPermission(runtimeStore.getState())
  if (!found) {
    if (cachedPendingPermissionSnapshot !== EMPTY_PENDING_PERMISSION_SNAPSHOT) {
      cachedPendingPermissionSnapshot = EMPTY_PENDING_PERMISSION_SNAPSHOT
    }
    return cachedPendingPermissionSnapshot
  }
  const prev = cachedPendingPermissionSnapshot
  if (
    prev.sessionKey === found.sessionKey &&
    prev.pending?.requestId === found.pending.requestId
  ) {
    return prev
  }
  cachedPendingPermissionSnapshot = {
    sessionKey: found.sessionKey,
    pending: found.pending,
  }
  return cachedPendingPermissionSnapshot
}

/** 重置 Store（用于测试） */
export function resetRuntimeStore(): void {
  cachedPendingPermissionSnapshot = EMPTY_PENDING_PERMISSION_SNAPSHOT
  runtimeStore.setState(() => getDefaultRuntimeState())
}

export type { RuntimeStore, AgentRuntimeEvent }
