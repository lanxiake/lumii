/**
 * 内部事件 DTO — 网关 ↔ api-server Redis Stream 契约
 *
 * 所有跨进程异步事件的信封（InternalEvent<T>）与负载类型定义。
 * 与 packages/protocol 共享，通过 @mtbot/protocol facade 导出。
 *
 * 设计原则（doc 10 §4.1-4.4）：
 * - 事件 type 统一 `domain.action` 格式
 * - id 是业务幂等键（聊天用 messageId），与 Stream entry ID 区分
 * - traceId 贯穿网关→Stream→api-server→落库（对治 D-04）
 * - Stream key 在代码中不含 mtbot: 前缀（ioredis keyPrefix 自动加）
 */

// ── Stream Key 常量 ────────────────────────────────────────────────────────
// ioredis keyPrefix="mtbot:" 自动加前缀，代码中无需写 mtbot:
// 物理 key: mtbot:usage / mtbot:chat / mtbot:log

export const STREAM_KEYS = {
  /** 用量上报：网关 → api-server（计费+日志） */
  USAGE: "usage",
  /** 聊天落库：网关 → api-server（本地优先，DB 最终一致） */
  CHAT: "chat",
  /** 日志归集：网关/客户端 → api-server */
  LOG: "log",
} as const;

export type StreamKey = (typeof STREAM_KEYS)[keyof typeof STREAM_KEYS];

// ── 消费者组名常量 ──────────────────────────────────────────────────────────

export const CONSUMER_GROUPS = {
  USAGE_INGEST: "usage-ingest",
  CHAT_INGEST: "chat-ingest",
  LOG_INGEST: "log-ingest",
} as const;

// ── 信封（envelope） ────────────────────────────────────────────────────────

/**
 * 所有内部事件的通用信封
 *
 * @template T 事件负载类型
 */
export interface InternalEvent<T = unknown> {
  /** 事件类型（`domain.action`，如 "usage.report"）*/
  type: InternalEventType;
  /** 业务幂等键（用于消费侧去重；聊天事件用 messageId）*/
  id: string;
  /** 产出时间戳（ms since epoch）*/
  ts: number;
  /** 产出方网关实例 ID（多实例区分）*/
  source: string;
  /** 贯穿链路的 trace ID（对治 D-04，可选）*/
  traceId?: string;
  /** 事件负载 */
  payload: T;
}

// ── 事件类型枚举 ─────────────────────────────────────────────────────────────

export const INTERNAL_EVENT_TYPES = {
  /** 用量上报：LLM 调用完成后网关产出 */
  USAGE_REPORT: "usage.report",
  /** 聊天落库：网关转发完成后产出 */
  CHAT_PERSIST: "chat.persist",
  /** 日志归集 */
  LOG_INGEST: "log.ingest",
} as const;

export type InternalEventType =
  (typeof INTERNAL_EVENT_TYPES)[keyof typeof INTERNAL_EVENT_TYPES];

// ── 事件负载类型 ──────────────────────────────────────────────────────────────

/**
 * usage.report — LLM 用量上报负载
 * Stream: mtbot:usage（代码写 "usage"）
 */
export interface LlmUsageReportPayload {
  /** 用户 ID（JWT sub 或 "anonymous"）*/
  userId: string;
  /** 会话 key（可选，用于聊天关联）*/
  sessionId?: string;
  /** 模型 ID（如 "claude-sonnet-4-5"）*/
  model: string;
  /** 提供商（anthropic / openai / google）*/
  provider: string;
  /** auth-profile ID（null 表示使用环境变量）*/
  profileId: string | null;
  /** 输入 token 数 */
  inputTokens: number;
  /** 输出 token 数 */
  outputTokens: number;
  /** 总 token 数 */
  totalTokens: number;
  /** 缓存读 token 数 */
  cacheReadTokens: number;
  /** 缓存写 token 数 */
  cacheWriteTokens: number;
  /** 请求耗时（ms）*/
  latencyMs: number;
  /** 是否成功 */
  success: boolean;
  /** 失败时的错误码 */
  errorCode?: string;
  /** 计算出的积分消耗（gateway 侧计算，api-server 可用于校验）*/
  creditsHint?: number;
  /** Agent run ID（客户端 metadata.runId，用于 Langfuse trace 关联）*/
  runId?: string;
  /** Agent 定义 ID（客户端 metadata.agentId，用于 Langfuse trace 命名 agent-run:<agentId>）*/
  agentId?: string;
  /** Agent 显示名称（客户端 metadata.agentName，便于观测面板展示）*/
  agentName?: string;
  /** 调用来源频道（如 windows-agent-runtime）*/
  channel?: string;
  /** 业务用途（chat / memory_extract / skill_route 等，与 capability_slots.slot 或逻辑标签一致）*/
  purpose?: string;
  /** 请求输入内容（JSON 序列化，审计用，可选截断）*/
  inputContent?: string;
  /** 响应输出内容（JSON 序列化，审计用，可选截断）*/
  outputContent?: string;
}

/**
 * chat.persist — 聊天落库负载
 * Stream: mtbot:chat（代码写 "chat"）
 */
export interface ChatPersistPayload {
  /** 会话 key（全局唯一，如 "userId:channelId:threadId"）*/
  sessionKey: string;
  /** 消息 ID（幂等键，去重用；网关分配，充当 messages.id 主键）*/
  messageId: string;
  /** 消息角色 */
  role: "user" | "assistant" | "system";
  /** 消息内容（文本，落 messages.content）*/
  content: unknown;
  /** 来源通道（weixin / telegram 等）*/
  channel?: string;
  /** 消息创建时间（ISO 8601）*/
  createdAt: string;
  /** 附件列表（可选）*/
  attachments?: Array<{
    fileId: string;
    name: string;
    type: string;
    url?: string;
  }>;
  /** 工具调用记录（可选，assistant 消息）*/
  toolCalls?: Record<string, unknown>[];
  /** 工具执行结果（可选）*/
  toolResults?: Record<string, unknown>[];
  /** Token 消耗数（可选）*/
  tokenCount?: number;
  /** 使用的模型 ID（可选）*/
  modelId?: string;
  /** 扩展元数据（可选）*/
  metadata?: Record<string, unknown>;
  /** 首次创建 conversation 时的元信息（可选）*/
  convMeta?: {
    type?: "chat" | "task" | "agent" | "friend";
    title?: string;
  };
}

/**
 * log.ingest — 日志归集负载
 * Stream: mtbot:log（代码写 "log"）
 */
export interface LogIngestPayload {
  /** 日志级别 */
  level: "debug" | "info" | "warn" | "error";
  /** 子系统标识 */
  scope: string;
  /** 日志消息 */
  message: string;
  /** 附加元数据 */
  meta?: Record<string, unknown>;
}

// ── 具名事件类型别名 ──────────────────────────────────────────────────────────

export type UsageReportEvent = InternalEvent<LlmUsageReportPayload>;
export type ChatPersistEvent = InternalEvent<ChatPersistPayload>;
export type LogIngestEvent = InternalEvent<LogIngestPayload>;
