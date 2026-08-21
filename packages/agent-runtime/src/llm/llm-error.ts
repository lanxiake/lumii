/**
 * LLM 错误归一化 —— 所有取流路径（网关 SSE / direct 直连 / pi-ai 内部）共用
 *
 * 各 provider 返回的错误形态差异很大：网关给结构化 JSON，直连时 pi-ai 只在
 * AssistantMessage.errorMessage 上留一句自由文本（如 "401 无效的令牌 (request id: xxx)"）。
 * 本模块把它们统一成 {@link LlmErrorDetail}，让 mapAgentEvent → IPC → UI 拿到同一套
 * code/retryable/httpStatus，从而不会出现「后端报错、界面毫无反应」。
 *
 * 纯函数、零依赖（含类型依赖），可在渲染进程复用（见 src/browser.ts）。
 * 引入 pi-ai 等运行时包的类型会把它们拖进渲染侧模块图，故此处刻意不 import 任何东西。
 */

/** 结构化 LLM 错误，映射到 AgentRuntimeEvent / UI */
export interface LlmErrorDetail {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
}

/** HTTP 状态 → 稳定错误码（UI 据此给出中文指引） */
const HTTP_STATUS_TO_CODE: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  402: "insufficient_credits",
  403: "forbidden",
  404: "not_found",
  408: "timeout",
  422: "bad_request",
  429: "rate_limited",
  500: "server_error",
  502: "bad_gateway",
  503: "bad_gateway",
  504: "timeout",
};

/** 重试大概率能成功的状态码（限流 / 网关抖动 / 超时） */
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** 判定 HTTP 状态是否适合自动重试 / 降级换模 */
export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUS.has(status);
}

/** HTTP 状态 → 错误码；未知状态回落为 `http_<status>` */
export function llmErrorCodeFromHttpStatus(status: number): string {
  return HTTP_STATUS_TO_CODE[status] ?? `http_${status}`;
}

/**
 * 从自由文本里推断 HTTP 状态码。
 *
 * provider SDK 常把状态码拼在消息开头（"401 无效的令牌"、"HTTP 429 Too Many Requests"）。
 * 只认独立成词的 4xx/5xx，避免把 request id 里的数字段误判成状态码。
 */
export function inferHttpStatusFromMessage(raw: string): number | undefined {
  const matched = raw.match(/\b([45]\d{2})\b/);
  if (!matched) return undefined;
  return Number.parseInt(matched[1]!, 10);
}

/** 无 HTTP 状态时，从关键词判断是否为可重试的网络类故障 */
function isRetryableNetworkMessage(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    lower.includes("fetch") ||
    lower.includes("network") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("etimedout") ||
    lower.includes("socket hang up") ||
    lower.includes("timeout")
  );
}

/** {@link normalizeLlmError} 的可选覆盖项 */
export interface NormalizeLlmErrorOptions {
  /** 已知的 HTTP 状态（网关路径可直接给出，省去正则推断） */
  readonly httpStatus?: number;
  /** 服务端明确给出的错误类型，优先级高于状态码推断 */
  readonly code?: string;
  /** 推断不出状态码时使用的兜底错误码 */
  readonly fallbackCode?: string;
  /** 强制指定可重试性 */
  readonly retryable?: boolean;
}

/**
 * 把任意来源的 LLM 错误文本归一化为结构化错误。
 *
 * @param rawMessage provider / 网关给出的原始错误文本，可为空
 * @param options 已知信息覆盖项
 */
export function normalizeLlmError(
  rawMessage: string | undefined,
  options: NormalizeLlmErrorOptions = {},
): LlmErrorDetail {
  const message = rawMessage?.trim() || "模型服务返回了未知错误";
  const httpStatus = options.httpStatus ?? inferHttpStatusFromMessage(message);
  const code =
    options.code ??
    (httpStatus !== undefined
      ? llmErrorCodeFromHttpStatus(httpStatus)
      : (options.fallbackCode ?? "llm_error"));
  const retryable =
    options.retryable ??
    (httpStatus !== undefined ? isRetryableHttpStatus(httpStatus) : isRetryableNetworkMessage(message));

  return {
    code,
    message,
    retryable,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}

/** 错误码 → 用户能据此行动的中文指引 */
const LLM_ERROR_HINTS: Readonly<Record<string, string>> = {
  unauthorized: "模型 API Key 无效或已过期，请到「设置 → 模型服务」检查密钥",
  forbidden: "模型服务拒绝了本次请求，请检查 API Key 权限与该模型的可用范围",
  insufficient_credits: "模型服务账户余额不足，请充值后重试",
  rate_limited: "请求过于频繁被限流，请稍后重试或降低并发",
  not_found: "模型或接口地址不存在，请到「设置 → 模型服务」检查模型 ID 与 Base URL",
  bad_request: "模型服务拒绝了请求参数，请检查模型 ID 与生成参数配置",
  timeout: "模型服务响应超时，请稍后重试",
  server_error: "模型服务内部错误，请稍后重试",
  bad_gateway: "模型服务暂时不可用，请稍后重试",
  stream_error: "与模型服务的连接中断，请检查网络或 Base URL",
  sse_parse_error: "模型返回的数据无法解析，请稍后重试或更换模型",
  aborted: "请求已被取消",
};

/**
 * 生成用户可读的错误说明（Toast 与错误气泡共用）。
 *
 * 输出形如「模型 API Key 无效或已过期，请到「设置 → 模型服务」检查密钥（401 无效的令牌）」，
 * 既给出可执行指引，也保留服务商原文便于排查。
 */
export function describeLlmError(error: LlmErrorDetail): string {
  const hint = LLM_ERROR_HINTS[error.code];
  if (!hint) {
    return `模型调用失败：${error.message}`;
  }
  // 原文已被指引覆盖时不重复拼接，避免出现「请求已被取消（请求已被取消）」
  if (error.message === hint) return hint;
  return `${hint}（${error.message}）`;
}
