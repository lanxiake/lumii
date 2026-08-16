/**
 * GatewayStreamFn — HTTP SSE 流式 LLM 代理
 *
 * 将 pi-agent-core 的 streamFn 调用路由到网关的 `/v1/llm/stream`（M11），
 * 网关负责注入 API Key 并代理到 LLM 提供商。
 *
 * 自定义实现替代 streamProxy，支持在请求体中传递 metadata
 * （sessionId, runId, channel 等），使网关能记录完整的调用日志。
 */

import {
  EventStream,
  parseStreamingJson,
  type AssistantMessageEvent,
  type AssistantMessage,
  type Model,
} from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import {
  isRetryableHttpStatus,
  llmErrorCodeFromHttpStatus,
  normalizeLlmError,
  type GatewayLlmErrorDetail,
} from "./llm-error.js";

// 归一化后的错误类型已迁移到 llm-error.ts（direct/gateway 共用），此处再导出保持既有导入路径可用
export type { GatewayLlmErrorDetail, LlmErrorDetail } from "./llm-error.js";

/** partial 上挂载的结构化错误（mapAgentEvent 读取） */
export type AssistantMessageWithLlmError = AssistantMessage & {
  __llmError?: GatewayLlmErrorDetail;
};

/** 与 M11 `http-llm-proxy` 挂载路径一致 */
export const DEFAULT_GATEWAY_STREAM_PATH = "/v1/llm/stream";

/** 客户端传递给网关的元数据，用于日志和计费 */
export interface StreamMetadata {
  sessionId?: string;
  runId?: string;
  channel?: string;
  thinkLevel?: string;
  /** 是否开启思考模式（默认 true） */
  thinkingEnabled?: boolean;
  /** 推理强度：high / max（low/medium 在网关映射为 high，xhigh 映射为 max） */
  reasoningEffort?: "high" | "max";
  contextTokens?: number;
  /** Agent 默认用途槽（capability_slots.slot），由服务端 CapabilityResolver 解析为真实模型 */
  purpose?: string;
  /** Agent 定义 ID（用于 Langfuse trace 命名 agent-run:<agentId> 与按 Agent 归因） */
  agentId?: string;
  /** Agent 显示名称（可选，便于观测面板展示） */
  agentName?: string;
}

/** 重试/降级遥测（供桥接层转发到开发者工具或 UI） */
export type GatewayStreamDiagnostic =
  | { kind: "fallback"; fromModelId: string; toModelId: string; reason: string }
  | { kind: "http_error"; status: number; code: string; retryable: boolean };

export interface GatewayStreamConfig {
  /** 网关基础 URL (例如 "https://gw.mtbot.top" 或 "http://localhost:18789") */
  gatewayUrl: string;
  /** 流式端点路径，默认 {@link DEFAULT_GATEWAY_STREAM_PATH}，与 M11 一致 */
  streamPath?: string;
  /** 获取认证 Token 的异步函数 */
  getAuthToken: () => Promise<string>;
  /** 获取设备 ID 的函数（用于 X-Device-Id 请求头，支持设备 token 认证） */
  getDeviceId?: () => string | undefined;
  /** 可选的日志函数（默认使用 console）— 只应记录脱敏信息 */
  log?: (msg: string) => void;
  /** 可选的元数据提供函数（每次请求调用） */
  getMetadata?: () => StreamMetadata;
  /**
   * 对可重试 HTTP 错误是否尝试一次备用模型（需配合 getFallbackModel）
   */
  retryWithFallback?: boolean;
  /**
   * 主模型失败且错误可重试时返回备用模型；未定义则不降级
   */
  getFallbackModel?: (failed: Model<string>) => Model<string> | undefined;
  /** 重试/降级决策遥测 */
  onDiagnostic?: (info: GatewayStreamDiagnostic) => void;
  /** LLM 请求即将发出（fetch 前） */
  onLlmRequestStart?: () => void;
  /** 首个文本 token 到达 */
  onLlmFirstToken?: () => void;
}

/**
 * 从网关 JSON 错误体解析可读消息（格式对齐 sendJson: `{ error: string | { message, type } }`）
 */
function parseGatewayErrorJson(text: string): { message: string; type?: string } | null {
  try {
    const data = JSON.parse(text) as { error?: string | { message?: string; type?: string } };
    if (typeof data.error === "string") {
      return { message: data.error };
    }
    if (data.error && typeof data.error === "object") {
      const msg = data.error.message;
      if (typeof msg === "string") {
        return {
          message: msg,
          type: typeof data.error.type === "string" ? data.error.type : undefined,
        };
      }
    }
  } catch {
    // 非 JSON
  }
  return null;
}

/**
 * 将 HTTP 错误转为结构化 GatewayLlmErrorDetail
 */
export function gatewayErrorFromHttpResponse(
  status: number,
  bodyText: string,
): GatewayLlmErrorDetail {
  const parsed = parseGatewayErrorJson(bodyText);
  const message = parsed?.message ?? (bodyText.trim().slice(0, 500) || `HTTP ${status}`);
  return normalizeLlmError(message, {
    httpStatus: status,
    // 网关明确给出的 error.type 比状态码推断更准确
    ...(parsed?.type ? { code: parsed.type } : { code: llmErrorCodeFromHttpStatus(status) }),
    retryable: isRetryableHttpStatus(status),
  });
}

/**
 * 将非 HTTP 异常（网络、解析、中止）转为结构化错误
 */
function gatewayErrorFromThrowable(err: unknown, aborted: boolean): GatewayLlmErrorDetail {
  if (aborted) {
    return { code: "aborted", message: "Request aborted by user", retryable: false };
  }
  const message = err instanceof Error ? err.message : String(err);
  return normalizeLlmError(message, { code: "stream_error" });
}

/**
 * 规范化网关 URL 与 path，避免双斜杠
 */
function joinGatewayUrl(base: string, streamPath: string): string {
  const root = base.replace(/\/+$/, "");
  const path = streamPath.startsWith("/") ? streamPath : `/${streamPath}`;
  return `${root}${path}`;
}

/**
 * 创建 ProxyMessageEventStream
 *
 * 与 pi-agent-core 的 ProxyMessageEventStream 行为一致：
 * - done/error 事件标记流结束
 * - 提取最终 AssistantMessage 作为 result
 */
function createProxyStream(): EventStream<AssistantMessageEvent, AssistantMessage> {
  return new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("Unexpected event type");
    },
  );
}

/**
 * ProxyAssistantMessageEvent — 网关 SSE 推送的精简事件类型
 *
 * 与 pi-agent-core/proxy 中的 ProxyAssistantMessageEvent 类型一致。
 * 不含 partial 字段，由客户端本地重建。
 */
type ProxyEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; contentSignature?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; contentSignature?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | { type: "done"; reason: string; usage: AssistantMessage["usage"] }
  | { type: "error"; reason: string; errorMessage?: string; usage: AssistantMessage["usage"] };

/**
 * 将 ProxyEvent 转为完整的 AssistantMessageEvent（含 partial）
 *
 * 逻辑完全对齐 pi-agent-core/proxy.js 的 processProxyEvent。
 */
function processProxyEvent(
  proxyEvent: ProxyEvent,
  partial: AssistantMessage,
): AssistantMessageEvent | undefined {
  switch (proxyEvent.type) {
    case "start":
      return { type: "start", partial } as AssistantMessageEvent;

    case "text_start":
      (partial.content as any[])[proxyEvent.contentIndex] = { type: "text", text: "" };
      return {
        type: "text_start",
        contentIndex: proxyEvent.contentIndex,
        partial,
      } as AssistantMessageEvent;

    case "text_delta": {
      const content = (partial.content as any[])[proxyEvent.contentIndex];
      if (content?.type === "text") {
        content.text += proxyEvent.delta;
        return {
          type: "text_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial,
        } as AssistantMessageEvent;
      }
      throw new Error("Received text_delta for non-text content");
    }

    case "text_end": {
      const content = (partial.content as any[])[proxyEvent.contentIndex];
      if (content?.type === "text") {
        content.textSignature = proxyEvent.contentSignature;
        return {
          type: "text_end",
          contentIndex: proxyEvent.contentIndex,
          content: content.text,
          partial,
        } as AssistantMessageEvent;
      }
      throw new Error("Received text_end for non-text content");
    }

    case "thinking_start":
      (partial.content as any[])[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
      return {
        type: "thinking_start",
        contentIndex: proxyEvent.contentIndex,
        partial,
      } as AssistantMessageEvent;

    case "thinking_delta": {
      const content = (partial.content as any[])[proxyEvent.contentIndex];
      if (content?.type === "thinking") {
        content.thinking += proxyEvent.delta;
        return {
          type: "thinking_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial,
        } as AssistantMessageEvent;
      }
      throw new Error("Received thinking_delta for non-thinking content");
    }

    case "thinking_end": {
      const content = (partial.content as any[])[proxyEvent.contentIndex];
      if (content?.type === "thinking") {
        content.thinkingSignature = proxyEvent.contentSignature;
        return {
          type: "thinking_end",
          contentIndex: proxyEvent.contentIndex,
          content: content.thinking,
          partial,
        } as AssistantMessageEvent;
      }
      throw new Error("Received thinking_end for non-thinking content");
    }

    case "toolcall_start":
      (partial.content as any[])[proxyEvent.contentIndex] = {
        type: "toolCall",
        id: proxyEvent.id,
        name: proxyEvent.toolName,
        arguments: {},
        partialJson: "",
      };
      return {
        type: "toolcall_start",
        contentIndex: proxyEvent.contentIndex,
        partial,
      } as AssistantMessageEvent;

    case "toolcall_delta": {
      const content = (partial.content as any[])[proxyEvent.contentIndex];
      if (content?.type === "toolCall") {
        content.partialJson += proxyEvent.delta;
        content.arguments = parseStreamingJson(content.partialJson) || {};
        (partial.content as any[])[proxyEvent.contentIndex] = { ...content };
        return {
          type: "toolcall_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial,
        } as AssistantMessageEvent;
      }
      throw new Error("Received toolcall_delta for non-toolCall content");
    }

    case "toolcall_end": {
      const content = (partial.content as any[])[proxyEvent.contentIndex];
      if (content?.type === "toolCall") {
        delete content.partialJson;
        return {
          type: "toolcall_end",
          contentIndex: proxyEvent.contentIndex,
          toolCall: content,
          partial,
        } as AssistantMessageEvent;
      }
      return undefined;
    }

    case "done":
      partial.stopReason = proxyEvent.reason as any;
      partial.usage = proxyEvent.usage;
      return { type: "done", reason: proxyEvent.reason, message: partial } as AssistantMessageEvent;

    case "error":
      partial.stopReason = proxyEvent.reason as any;
      partial.errorMessage = proxyEvent.errorMessage;
      partial.usage = proxyEvent.usage;
      // 挂载结构化错误，确保 mapAgentEvent → message:end 携带 llmError，UI 可展示错误提示
      if (proxyEvent.errorMessage) {
        (partial as AssistantMessageWithLlmError).__llmError = normalizeLlmError(
          proxyEvent.errorMessage,
        );
      }
      return { type: "error", reason: proxyEvent.reason, error: partial } as AssistantMessageEvent;

    default:
      return undefined;
  }
}

/**
 * 将结构化错误挂到 partial 并推送 error 事件
 */
function pushStructuredError(
  stream: EventStream<AssistantMessageEvent, AssistantMessage>,
  partial: AssistantMessage,
  detail: GatewayLlmErrorDetail,
): void {
  const p = partial as AssistantMessageWithLlmError;
  p.__llmError = detail;
  partial.errorMessage = `[${detail.code}] ${detail.message}`;
  partial.stopReason = "error" as any;
  stream.push({
    type: "error",
    reason: "error",
    error: partial,
  } as AssistantMessageEvent);
  stream.end();
}

/**
 * 应用当前模型到 partial（降级后同步 model 字段）
 */
function applyModelToPartial(partial: AssistantMessage, m: Model<string>): void {
  partial.model = m.id;
  partial.api = m.api;
  (partial as { provider?: string }).provider = (m as { provider?: string }).provider;
}

/**
 * 创建通过网关代理的 StreamFn
 *
 * 自定义 HTTP SSE 实现，替代 pi-agent-core 的 streamProxy。
 * 网关负责：
 * 1. JWT Token 验证
 * 2. 注入 LLM 提供商 API Key
 * 3. 流式转发 SSE 事件
 * 4. 计费打点 + DB 日志记录
 *
 * 与 streamProxy 的区别：请求体额外携带 metadata 字段，
 * 使网关能记录 sessionId/runId/channel 等信息到 llm_call_logs。
 */
export function createGatewayStreamFn(config: GatewayStreamConfig): StreamFn {
  const {
    gatewayUrl,
    streamPath = DEFAULT_GATEWAY_STREAM_PATH,
    getAuthToken,
    getDeviceId,
    log: logFn,
    getMetadata,
    retryWithFallback = false,
    getFallbackModel,
    onDiagnostic,
    onLlmRequestStart,
    onLlmFirstToken,
  } = config;
  const emit = logFn ?? ((msg: string) => console.log(msg));

  return (model, context, options) => {
    const stream = createProxyStream();

    (async () => {
      const partial: AssistantMessage = {
        role: "assistant",
        stopReason: "stop",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      } as AssistantMessage;

      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const signal = options?.signal;
      let firstTokenEmitted = false;

      const abortHandler = () => {
        reader?.cancel("Request aborted by user").catch(() => {});
      };
      if (signal) {
        signal.addEventListener("abort", abortHandler);
      }

      const requestStarted = Date.now();
      let activeModel: Model<string> = model;
      let attempt = 0;
      const maxAttempts = retryWithFallback && getFallbackModel ? 2 : 1;

      try {
        const authToken = await getAuthToken();
        const targetUrl = joinGatewayUrl(gatewayUrl, streamPath);
        const metadata = getMetadata?.();
        const callPurpose =
          (options as { purpose?: string } | undefined)?.purpose ?? metadata?.purpose;
        const requestMetadata =
          metadata || callPurpose
            ? { ...metadata, ...(callPurpose ? { purpose: callPurpose } : {}) }
            : undefined;

        emit(
          `[GatewayStream] POST ${targetUrl} model=${activeModel.id} api=${activeModel.api ?? "none"} ` +
            `msgs=${context.messages?.length ?? 0}` +
            (requestMetadata?.sessionId ? ` sessionId=${requestMetadata.sessionId}` : "") +
            (requestMetadata?.runId ? ` runId=${requestMetadata.runId}` : "") +
            (callPurpose ? ` purpose=${callPurpose}` : ""),
        );

        if (!authToken) {
          emit(`[GatewayStream] WARNING: authToken is empty; request will likely fail with 401.`);
        }

        const deviceId = getDeviceId?.();

        onLlmRequestStart?.();

        // —— 可选：失败后用备用模型重试一次 —— //
        while (attempt < maxAttempts) {
          applyModelToPartial(partial, activeModel);

          const response = await fetch(targetUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${authToken}`,
              ...(deviceId ? { "X-Device-Id": deviceId } : {}),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: activeModel,
              context,
              options: {
                temperature: options?.temperature,
                maxTokens: options?.maxTokens,
                reasoning:
                  metadata?.thinkingEnabled === false
                    ? false
                    : metadata?.thinkingEnabled === true
                      ? true
                      : options?.reasoning,
                thinkingEnabled: metadata?.thinkingEnabled,
                reasoningEffort: metadata?.reasoningEffort ?? metadata?.thinkLevel,
              },
              ...(callPurpose ? { purpose: callPurpose } : {}),
              ...(requestMetadata ? { metadata: requestMetadata } : {}),
            }),
            signal,
          });

          const elapsed = Date.now() - requestStarted;
          emit(
            `[GatewayStream] response status=${response.status} model=${activeModel.id} durationMs=${elapsed} ` +
              `(prompt chars not logged)`,
          );

          if (!response.ok) {
            let bodyText = "";
            try {
              bodyText = await response.text();
            } catch {
              bodyText = "";
            }
            const detail = gatewayErrorFromHttpResponse(response.status, bodyText);
            emit(
              `[GatewayStream] ERROR status=${response.status} code=${detail.code} ` +
                `retryable=${detail.retryable} message="${detail.message}" ` +
                `body="${bodyText.slice(0, 500)}"`,
            );
            onDiagnostic?.({
              kind: "http_error",
              status: response.status,
              code: detail.code,
              retryable: detail.retryable,
            });

            const canFallback =
              attempt === 0 &&
              detail.retryable &&
              retryWithFallback &&
              typeof getFallbackModel === "function";
            const nextModel = canFallback ? getFallbackModel(activeModel) : undefined;

            if (nextModel) {
              onDiagnostic?.({
                kind: "fallback",
                fromModelId: activeModel.id,
                toModelId: nextModel.id,
                reason: detail.code,
              });
              emit(
                `[GatewayStream] retry with fallback model=${nextModel.id} (from=${activeModel.id}, reason=${detail.code})`,
              );
              activeModel = nextModel;
              attempt++;
              continue;
            }

            pushStructuredError(stream, partial, detail);
            return;
          }

          // —— SSE 正文 —— //
          const body = response.body;
          if (!body) {
            pushStructuredError(stream, partial, {
              code: "empty_body",
              message: "Response body is null",
              retryable: false,
              httpStatus: response.status,
            });
            return;
          }

          reader = body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (signal?.aborted) {
              pushStructuredError(
                stream,
                partial,
                gatewayErrorFromThrowable(new Error("Request aborted by user"), true),
              );
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (!data) continue;
                try {
                  const proxyEvent = JSON.parse(data) as ProxyEvent;
                  if (proxyEvent.type === "text_delta" && !firstTokenEmitted) {
                    firstTokenEmitted = true;
                    onLlmFirstToken?.();
                  }
                  const event = processProxyEvent(proxyEvent, partial);
                  if (event) {
                    stream.push(event);
                  }
                } catch (parseErr) {
                  const detail: GatewayLlmErrorDetail = {
                    code: "sse_parse_error",
                    message: parseErr instanceof Error ? parseErr.message : String(parseErr),
                    retryable: false,
                  };
                  emit(`[GatewayStream] SSE JSON parse failed: ${detail.message}`);
                  pushStructuredError(stream, partial, detail);
                  return;
                }
              }
            }
          }

          if (signal?.aborted) {
            pushStructuredError(
              stream,
              partial,
              gatewayErrorFromThrowable(new Error("Request aborted by user"), true),
            );
            return;
          }

          stream.end();
          return;
        }
      } catch (error) {
        const detail = gatewayErrorFromThrowable(error, Boolean(signal?.aborted));
        pushStructuredError(stream, partial, detail);
      } finally {
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
      }
    })();

    return stream as ReturnType<StreamFn>;
  };
}
