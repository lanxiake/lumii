/**
 * 多开发类 AI 工具后端标识与类型（对齐 weixin-agent-gateway 多后端模型）。
 * 默认 `openclaw` 走 MtBot 内置 Pi 代理；其余后端通过本地 ACP 子进程对接各 CLI。
 */

export const DEFAULT_CODING_DEV_BACKEND_ID = "openclaw" as const;

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
export type LightweightCodingDevBackendId = Exclude<ImplementedCodingDevBackendId, "openclaw">;

export const CODING_DEV_BACKEND_LABELS: Record<CodingDevBackendId, string> = {
  openclaw: "OpenClaw / MtBot 主代理",
  cursor: "Cursor CLI",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export type BackendSelectionSource = "default" | "stored" | "fallback";

export type CodingDevLightweightBackendInput = {
  accountId: string;
  peerId: string;
  senderId: string;
  text: string;
  imagePaths: string[];
  contextToken?: string;
  messageId?: string;
  timestamp?: number;
  emitProgress?: (progress: CodingDevLightweightBackendProgress) => Promise<void> | void;
  /** 外部中止信号：aborted 时应 cancel ACP session 并尽快返回 */
  abortSignal?: AbortSignal;
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
  kind: "message" | "plan" | "status" | "tool" | "thinking";
  text: string;
  /** 当 kind:"tool" 时携带结构化工具信息 */
  tool?: CodingDevToolProgress;
};

export type CodingDevLightweightBackendAdapter = {
  id: LightweightCodingDevBackendId;
  mode: "lightweight";
  reply: (
    input: CodingDevLightweightBackendInput,
  ) => Promise<CodingDevLightweightBackendOutput | void>;
};

export type ResolvedCodingDevBackend = {
  requestedBackendId: CodingDevBackendId;
  backendId: ImplementedCodingDevBackendId;
  source: BackendSelectionSource;
  warning?: string;
};

export function isCodingDevBackendId(value: string): value is CodingDevBackendId {
  return (CODING_DEV_BACKEND_IDS as readonly string[]).includes(value);
}

export function isImplementedCodingDevBackendId(
  value: CodingDevBackendId,
): value is ImplementedCodingDevBackendId {
  return (IMPLEMENTED_CODING_DEV_BACKEND_IDS as readonly string[]).includes(value);
}

export function isLightweightCodingDevBackendId(
  value: ImplementedCodingDevBackendId,
): value is LightweightCodingDevBackendId {
  return value !== "openclaw";
}

/**
 * 将用户输入规范化为后端 ID（兼容别名）。
 */
export function normalizeCodingDevBackendId(raw: string): CodingDevBackendId | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === "claude-code") return "claude";
  if (trimmed === "open-code" || trimmed === "opencode-ai") return "opencode";
  if (trimmed === "cursor-cli" || trimmed === "cursor-agent") return "cursor";
  if (trimmed === "mtbot" || trimmed === "lumii" || trimmed === "main") return "openclaw";
  return isCodingDevBackendId(trimmed) ? trimmed : undefined;
}
