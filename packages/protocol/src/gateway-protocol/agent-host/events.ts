/**
 * agent-host 输出事件契约（host → 客户端，ProtocolEvent）
 *
 * 这些事件由 host 产出（可信），承载在现有 `EventFrame.payload` 里经 stdio 外发。
 * 客户端只认 ProtocolEvent，与 pi-agent-core 内核彻底解耦——未来换内核不动客户端。
 *
 * 映射来源：现有 `AgentRuntimeEvent`（packages/agent-runtime/src/types/events.ts），
 * 由 apps/agent-host 的 event-adapter 显式桥接（§4c.4 映射表）。
 *
 * 设计依据: §3.2 / §4c.4 / §4d.6
 * 计划依据: .qoder/plan/2026-06-26-plan-B-agent-host.md §B0 / §B2b
 *
 * 输出事件由 host 产出，**无需 AJV 校验**（信任内部产出）；只需稳定的静态类型。
 */

// ── 事件名常量（AG-UI 风格分类）─────────────────────────────────────────────

export const PROTOCOL_EVENTS = {
  // Lifecycle —— 一轮的起止
  RUN_STARTED: "run.started",
  RUN_FINISHED: "run.finished",
  RUN_ERROR: "run.error",
  // TextMessage —— token 流
  TEXT_START: "text.start",
  TEXT_DELTA: "text.delta",
  TEXT_END: "text.end",
  // ToolCall —— 工具调用
  TOOL_START: "tool.start",
  TOOL_ARGS: "tool.args",
  TOOL_RESULT: "tool.result",
  TOOL_END: "tool.end",
  // State —— 上下文/会话状态增量同步
  STATE_SNAPSHOT: "state.snapshot",
  STATE_DELTA: "state.delta",
  // Interrupt —— 权限审批
  INTERRUPT_PERMISSION: "interrupt.permission",
  // Task —— 多 Agent 异步任务（§4d.6）
  TASK_SPAWNED: "task.spawned",
  TASK_PROGRESS: "task.progress",
  TASK_COMPLETED: "task.completed",
  AGENT_WAITING: "agent.waiting",
} as const;

export type ProtocolEventName = (typeof PROTOCOL_EVENTS)[keyof typeof PROTOCOL_EVENTS];

// ── 共享子类型 ────────────────────────────────────────────────────────────────

/** LLM 用量（来自 AssistantMessage.usage） */
export interface ProtocolUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** 本轮注入的热记忆（供「基于您的偏好」提示） */
export interface ProtocolInjectedMemory {
  readonly id: string;
  readonly content: string;
  readonly category: string;
}

/** 统一停止原因 */
export type ProtocolStopReason = "end_turn" | "tool_use" | "max_tokens" | "error" | "aborted";

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export interface RunStartedEvent {
  readonly event: typeof PROTOCOL_EVENTS.RUN_STARTED;
  readonly sessionId: string;
  readonly instanceId: string;
}

export interface RunFinishedEvent {
  readonly event: typeof PROTOCOL_EVENTS.RUN_FINISHED;
  readonly sessionId: string;
  readonly instanceId: string;
  /** 循环被中断（abort）时为 true */
  readonly loopInterrupted?: boolean;
}

export interface RunErrorEvent {
  readonly event: typeof PROTOCOL_EVENTS.RUN_ERROR;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly error: string;
  readonly code?: string;
  readonly retryable?: boolean;
}

// ── TextMessage ───────────────────────────────────────────────────────────────

export interface TextStartEvent {
  readonly event: typeof PROTOCOL_EVENTS.TEXT_START;
  readonly sessionId: string;
  readonly instanceId: string;
}

export interface TextDeltaEvent {
  readonly event: typeof PROTOCOL_EVENTS.TEXT_DELTA;
  readonly sessionId: string;
  readonly instanceId: string;
  /** 增量文本片段 */
  readonly delta: string;
  /** 累积完整文本（便于客户端直接渲染） */
  readonly fullText?: string;
  /** reasoning 增量标记（message:thinking 映射时为 true） */
  readonly reasoning?: boolean;
}

export interface TextEndEvent {
  readonly event: typeof PROTOCOL_EVENTS.TEXT_END;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly fullText: string;
  readonly usage?: ProtocolUsage;
  readonly stopReason?: ProtocolStopReason;
  readonly injectedMemories?: readonly ProtocolInjectedMemory[];
}

// ── ToolCall ──────────────────────────────────────────────────────────────────

export interface ToolStartEvent {
  readonly event: typeof PROTOCOL_EVENTS.TOOL_START;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

export interface ToolArgsEvent {
  readonly event: typeof PROTOCOL_EVENTS.TOOL_ARGS;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /** 部分结果（tool:update 映射） */
  readonly partialResult: unknown;
}

export interface ToolResultEvent {
  readonly event: typeof PROTOCOL_EVENTS.TOOL_RESULT;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: unknown;
  readonly isError: boolean;
}

export interface ToolEndEvent {
  readonly event: typeof PROTOCOL_EVENTS.TOOL_END;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

export interface StateDeltaEvent {
  readonly event: typeof PROTOCOL_EVENTS.STATE_DELTA;
  readonly sessionId: string;
  readonly instanceId: string;
  /** 上下文压缩用量同步（context:compaction 映射） */
  readonly compaction?: {
    readonly tokensBefore: number;
    readonly tokensAfter: number;
    readonly threshold: number;
    readonly messagesBefore: number;
    readonly messagesAfter: number;
    readonly usedSummary: boolean;
    readonly strategy?: "micro" | "summary" | "hard-trim" | "none";
  };
}

export interface StateSnapshotEvent {
  readonly event: typeof PROTOCOL_EVENTS.STATE_SNAPSHOT;
  readonly sessionId: string;
  readonly instanceId: string;
  /** 会话状态快照（resume 时使用，结构由 host 决定） */
  readonly snapshot: unknown;
}

// ── Interrupt ─────────────────────────────────────────────────────────────────

export interface InterruptPermissionEvent {
  readonly event: typeof PROTOCOL_EVENTS.INTERRUPT_PERMISSION;
  readonly sessionId: string;
  readonly instanceId: string;
  /** 与 permission.respond 配对 */
  readonly requestId: string;
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
  readonly description: string;
}

// ── Task（多 Agent 异步任务，§4d.6）────────────────────────────────────────

export interface TaskSpawnedEvent {
  readonly event: typeof PROTOCOL_EVENTS.TASK_SPAWNED;
  readonly sessionId: string;
  /** 父 Agent 实例 id */
  readonly parentInstanceId: string;
  /** 后台子 Agent 实例 id */
  readonly childInstanceId: string;
  /** 任务名称（如「生成封面图」） */
  readonly name: string;
}

export interface TaskProgressEvent {
  readonly event: typeof PROTOCOL_EVENTS.TASK_PROGRESS;
  readonly sessionId: string;
  readonly childInstanceId: string;
  /** 进度描述（可选，子 Agent 关键事件转发） */
  readonly note?: string;
}

export interface TaskCompletedEvent {
  readonly event: typeof PROTOCOL_EVENTS.TASK_COMPLETED;
  readonly sessionId: string;
  readonly parentInstanceId: string;
  readonly childInstanceId: string;
  readonly name: string;
  /** 任务是否成功 */
  readonly success: boolean;
}

export interface AgentWaitingEvent {
  readonly event: typeof PROTOCOL_EVENTS.AGENT_WAITING;
  readonly sessionId: string;
  readonly instanceId: string;
  /** 仍在跑的 pending 任务数 */
  readonly pendingTasks: number;
}

// ── 联合类型 ──────────────────────────────────────────────────────────────────

/**
 * 协议事件联合：host → 客户端的全部事件形状。
 * 承载在 EventFrame.payload；客户端用 `payload.event` 判别。
 */
export type ProtocolEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ToolStartEvent
  | ToolArgsEvent
  | ToolResultEvent
  | ToolEndEvent
  | StateDeltaEvent
  | StateSnapshotEvent
  | InterruptPermissionEvent
  | TaskSpawnedEvent
  | TaskProgressEvent
  | TaskCompletedEvent
  | AgentWaitingEvent;
