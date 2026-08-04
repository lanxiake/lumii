/**
 * agent-host 方法名常量 + 协议元信息
 *
 * 客户端 → host 的 RPC 方法名（承载在 RequestFrame.method）。
 * 与 skill-execution.ts 的 *_METHOD 常量风格一致。
 *
 * 设计依据: §3.2
 * 计划依据: .qoder/plan/2026-06-26-plan-B-agent-host.md §B0
 */

/** 客户端 → host 的 RPC 方法名 */
export const AGENT_HOST_METHODS = {
  SESSION_CREATE: "session.create",
  SESSION_PROMPT: "session.prompt",
  SESSION_STEER: "session.steer",
  SESSION_ABORT: "session.abort",
  SESSION_RESUME: "session.resume",
  SESSION_DESTROY: "session.destroy",
  PERMISSION_RESPOND: "permission.respond",
} as const;

export type AgentHostMethod = (typeof AGENT_HOST_METHODS)[keyof typeof AGENT_HOST_METHODS];

/** session.create 成功响应 payload（承载在 ResponseFrame.payload） */
export interface SessionCreateResult {
  readonly sessionId: string;
  readonly instanceId: string;
}
