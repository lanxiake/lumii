/**
 * useChat.types.ts - 对话管理类型定义
 */

/** 消息附件类型 */
export interface MessageAttachment {
  type: 'file' | 'image'
  mimeType: string
  fileName: string
  content: string
  preview?: string
}

/** 消息类型 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  isStreaming?: boolean
  isAborted?: boolean
  error?: string
  /** 隐藏消息，不在界面显示 */
  hidden?: boolean
  attachments?: MessageAttachment[]
  toolCalls?: ToolCall[]
  /** 关联的 agent runId，用于查找对应的工具调用记录 */
  runId?: string
  /** LLM token 用量（本地 Runtime 模式下填充） */
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheRead?: number
    cacheWrite?: number
  }
  /** 思考过程文字（本地 Runtime 模式下填充，支持 extended thinking） */
  thinkingText?: string
  /** 流式耗时与输出速度（本地 Runtime） */
  streamMetrics?: {
    durationMs: number
    tokensPerSecond: number
  }
  /** 网关结构化 LLM 错误（本地 Runtime） */
  llmError?: { code: string; message: string; retryable: boolean }
  /** 本地 Runtime：本轮回复使用的热记忆（用于 UI 轻量提示） */
  injectedMemories?: readonly { id: string; content: string; category: string }[]
  /** 本地 Runtime：子 Agent 消息嵌套展示 */
  sourceAgent?: { instanceId: string; label: string }
  /** 是否为语音识别消息（用户通过语音通话输入） */
  isVoice?: boolean
  /** 原始录音 WAV base64（仅语音消息，用于气泡点击回放） */
  audioWavBase64?: string
}

/** 工具调用 */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'failed'
  result?: unknown
  error?: string
  startTime: Date
  endTime?: Date
  /** 工具执行耗时（ms），来自后端真实统计 */
  durationMs?: number
  /** 工具调用开始时，当前 assistant 消息的文字字符数（用于交错渲染） */
  textPositionAtStart?: number
  /** 子 Agent 名称标签（子 Agent 执行的工具调用附此字段，用于卡片头部标识来源） */
  agentLabel?: string
}

/** 会话来源类型 */
export type SessionSource = 'local' | 'server'

/** 会话类型 */
export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: Date
  updatedAt: Date
  source: SessionSource
  serverKey?: string
  serverKind?: 'direct' | 'group' | 'global' | 'unknown'
  messagesLoaded?: boolean
  /** 会话是否正在流式生成中 */
  isStreaming?: boolean
  /** 当前流式消息的ID */
  streamingMessageId?: string
  /** 会话是否置顶（由 SQLite conversations.is_pinned 驱动，通过 conversation:pin-toggle IPC 更新） */
  isPinned?: boolean
  /** 关联的 Agent ID */
  agentId?: string
  /** 上次运行被中断（客户端重启检测到 is_streaming=1 残留） */
  wasInterrupted?: boolean
  /** 会话渠道：'default' | 'wechat' | 'wecom' | 'feishu' */
  channel?: string
}

/** 流式消息状态 */
export interface StreamingMessage {
  runId: string
  sessionKey: string
  content: string
  isStreaming: boolean
  isComplete: boolean
  isAborted?: boolean
  error?: string
}

/** Chat 事件负载 */
export interface ChatEventPayload {
  runId: string
  sessionKey: string
  state: 'delta' | 'final' | 'error' | 'aborted'
  message?: Record<string, unknown>
  errorMessage?: string
  stopReason?: string
}

/** Agent 事件负载（包含 tool 执行和子 Agent 信息） */
export interface AgentEventPayload {
  /** 运行 ID */
  runId: string
  /** 事件序列号 */
  seq: number
  /** 事件流类型 */
  stream: 'tool' | 'lifecycle' | 'assistant' | 'compaction' | 'subagent' | 'error' | string
  /** 时间戳 */
  ts: number
  /** 事件数据 */
  data: AgentEventData
  /** 会话 Key */
  sessionKey?: string
  /** 客户端 runId */
  clientRunId?: string
}

/** Agent 事件数据 */
export interface AgentEventData {
  /** 阶段 */
  phase?: 'start' | 'update' | 'result' | 'spawn' | 'complete' | 'error' | 'end'
  /** 工具名称或子 Agent 名称 */
  name?: string
  /** 工具调用 ID */
  toolCallId?: string
  /** 参数 */
  args?: Record<string, unknown>
  /** 部分结果 */
  partialResult?: unknown
  /** 元数据 */
  meta?: string
  /** 是否出错 */
  isError?: boolean
  /** 结果 */
  result?: unknown
  /** 错误信息 */
  error?: string
  /** 子 Agent 会话 Key */
  childSessionKey?: string
  /** 任务描述 */
  task?: string
  /** 状态 */
  status?: string
  /** 其他数据字段 */
  [key: string]: unknown
}

/** 子 Agent 运行记录 */
export interface SubagentRun {
  id: string
  /** 关联的父级 runId */
  parentRunId: string
  /** 子 Agent 会话 Key */
  childSessionKey: string
  /** 任务描述 */
  task: string
  /** 状态 */
  status: 'running' | 'completed' | 'error' | 'timeout'
  /** 开始时间 */
  startTime: Date
  /** 结束时间 */
  endTime?: Date
  /** 运行结果 */
  result?: string
  /** 错误信息 */
  error?: string
}

/** 运行记录 */
export interface RunRecord {
  runId: string
  sessionKey: string
  startTime: Date
  endTime?: Date
  toolCalls: ToolCall[]
  subagents: SubagentRun[]
  status: 'running' | 'completed' | 'aborted' | 'error'
}

/** Agent 工作流项目（工具调用或子 Agent） */
export interface AgentWorkflowItem {
  id: string
  type: 'tool' | 'subagent'
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  /** 显示标题 */
  title: string
  /** 详细描述 */
  description?: string
  /** 输入参数 */
  input?: Record<string, unknown>
  /** 输出结果 */
  output?: unknown
  /** 错误信息 */
  error?: string
  startTime: Date
  endTime?: Date
  /** 后端计算的工具执行耗时（ms），优先于 startTime/endTime 计算 */
  durationMs?: number
  /** 关联的 runId */
  runId: string
  /** 关联的本地 sessionId，用于会话隔离 */
  sessionId?: string
  /** 工具调用开始时文字缓冲区的字节位置，用于交错渲染 */
  textPositionAtStart?: number
  /** 工具调用 ID（仅工具类型） */
  toolCallId?: string
  /** 子 Agent 会话 Key（仅子 Agent 类型） */
  childSessionKey?: string
  /** 子 Agent ID（仅子 Agent 类型，用于可视化展示） */
  agentId?: string
  /** 子 Agent 显示标签（仅子 Agent 类型） */
  agentLabel?: string
  /** 子 Agent 内部的工具调用事件（仅子 Agent 类型，用于展开详情渲染） */
  childItems?: ChildToolItem[]
}

/** 子 Agent 内部的工具调用事件（轻量版，用于卡片内展示） */
export interface ChildToolItem {
  toolCallId: string
  name: string
  status: 'running' | 'completed' | 'failed'
  input?: Record<string, unknown>
  output?: unknown
  error?: string
  startTime: Date
  endTime?: Date
}
