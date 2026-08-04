import type { ErrorShape } from "./types.js";

export const ErrorCodes = {
  NOT_LINKED: "NOT_LINKED",
  NOT_PAIRED: "NOT_PAIRED",
  AGENT_TIMEOUT: "AGENT_TIMEOUT",
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAVAILABLE: "UNAVAILABLE",
  RESOURCE_EXHAUSTED: "RESOURCE_EXHAUSTED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  Unauthorized: "Unauthorized",
  NotImplemented: "NotImplemented",
  // Phase 1: 新增错误码
  UNAUTHENTICATED: "UNAUTHENTICATED",
  NOT_FOUND: "NOT_FOUND",
  // Phase 2: Agent 运行时错误码
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  AUTH_PROFILE_EXHAUSTED: "AUTH_PROFILE_EXHAUSTED",
  CONTEXT_OVERFLOW: "CONTEXT_OVERFLOW",
  RATE_LIMITED: "RATE_LIMITED",
  BILLING_ERROR: "BILLING_ERROR",
  // Phase 4: 好友渠道权限控制
  PERMISSION_DENIED: "PERMISSION_DENIED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export function errorShape(
  code: ErrorCode,
  message: string,
  opts?: { details?: unknown; retryable?: boolean; retryAfterMs?: number },
): ErrorShape {
  return {
    code,
    message,
    ...opts,
  };
}
