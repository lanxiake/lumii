/**
 * 结构化消息类型
 *
 * Agent 间通信的消息协议。
 */

/** 纯文本消息 */
export interface TextMessage {
  readonly type: "text";
  readonly content: string;
}

/** 关闭请求 */
export interface ShutdownRequest {
  readonly type: "shutdown_request";
  readonly requestId: string;
  readonly reason?: string;
}

/** 关闭响应 */
export interface ShutdownResponse {
  readonly type: "shutdown_response";
  readonly requestId: string;
  readonly approve: boolean;
  readonly reason?: string;
}

/** 任务完成通知 */
export interface TaskNotification {
  readonly type: "task_notification";
  readonly taskId: string;
  readonly agentId: string;
  readonly status: "completed" | "failed" | "killed";
  readonly summary: string;
  readonly result?: string;
  readonly usage?: {
    readonly totalTokens: number;
    readonly toolUses: number;
    readonly durationMs: number;
  };
}

/** 计划审批请求 */
export interface PlanApprovalRequest {
  readonly type: "plan_approval_request";
  readonly requestId: string;
  readonly plan: string;
  readonly agentName: string;
}

/** 计划审批响应 */
export interface PlanApprovalResponse {
  readonly type: "plan_approval_response";
  readonly requestId: string;
  readonly approve: boolean;
  readonly feedback?: string;
}

/** 所有结构化消息的联合类型 */
export type StructuredMessage =
  | TextMessage
  | ShutdownRequest
  | ShutdownResponse
  | TaskNotification
  | PlanApprovalRequest
  | PlanApprovalResponse;

/** 判断是否为结构化消息 */
export function isStructuredMessage(value: string | StructuredMessage): value is StructuredMessage {
  return typeof value === "object" && value !== null && "type" in value;
}

/** 将字符串或结构化消息统一为 StructuredMessage */
export function normalizeMessage(value: string | StructuredMessage): StructuredMessage {
  if (typeof value === "string") {
    return { type: "text", content: value };
  }
  return value;
}

/** 将结构化消息序列化为 text 字段内容 */
export function serializeMessage(message: StructuredMessage): string {
  if (message.type === "text") return message.content;
  return JSON.stringify(message);
}

/** 尝试从 text 中解析结构化消息 */
export function parseStructuredMessage(text: string): StructuredMessage {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.type === "string") {
      return parsed as unknown as StructuredMessage;
    }
  } catch {
    // 不是 JSON，作为纯文本
  }
  return { type: "text", content: text };
}
