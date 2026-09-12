/**
 * 多开发类 AI 工具后端标识与类型（对齐 weixin-agent-gateway 多后端模型）。
 * 默认 `lumii` 走内置 Pi 代理；其余后端通过本地 ACP 子进程对接各 CLI。
 */

export const DEFAULT_CODING_DEV_BACKEND_ID = "lumii" as const;

export const CODING_DEV_BACKEND_IDS = [
  DEFAULT_CODING_DEV_BACKEND_ID,
  "cursor",
  "claude",
  "codex",
  "opencode",
] as const;

export const IMPLEMENTED_CODING_DEV_BACKEND_IDS = CODING_DEV_BACKEND_IDS;

export type CodingDevBackendId = (typeof CODING_DEV_BACKEND_IDS)[number];
export type ImplementedCodingDevBackendId = (typeof IMPLEMENTED_CODING_DEV_BACKEND_IDS)[number];

/** 非内置主代理、需 ACP 子进程的后端 ID */
export type LightweightCodingDevBackendId = Exclude<
  ImplementedCodingDevBackendId,
  typeof DEFAULT_CODING_DEV_BACKEND_ID
>;

export const CODING_DEV_BACKEND_LABELS: Record<CodingDevBackendId, string> = {
  lumii: "灵栖主 Agent",
  cursor: "Cursor CLI",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export type CodingDevLightweightBackendOutput = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

/** 工具调用进度阶段 */
export type CodingDevToolProgressPhase = "start" | "progress" | "end";

/** 工具调用进度结构（用于 kind:"tool"） */
export type CodingDevToolProgress = {
  toolCallId: string;
  toolName: string;
  phase: CodingDevToolProgressPhase;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
};

export type CodingDevLightweightBackendProgress = {
  kind: "message" | "plan" | "status" | "tool";
  text: string;
  /** 当 kind:"tool" 时携带结构化工具信息 */
  tool?: CodingDevToolProgress;
};

export function isCodingDevBackendId(value: string): value is CodingDevBackendId {
  return (CODING_DEV_BACKEND_IDS as readonly string[]).includes(value);
}

export function isImplementedCodingDevBackendId(
  value: CodingDevBackendId,
): value is ImplementedCodingDevBackendId {
  return (IMPLEMENTED_CODING_DEV_BACKEND_IDS as readonly string[]).includes(value);
}
