/**
 * direct-stream — 本地/自定义 provider 直连 streamFn
 *
 * 不经网关，直接用 pi-ai 的 streamSimple 调 LLM（本机 Ollama / LM Studio / 自定义
 * OpenAI 兼容端点）。凭据（baseUrl / apiKey）由 host 本地持有，经工厂注入，
 * 永不出 host 进程（设计 §四安全不变量）。
 *
 * pi-ai 已处理 provider 差异 + reasoning 补丁（streamSimple 内部），本模块不自行处理。
 *
 * 设计依据: §4b（local/custom 来源走 direct streamFn）
 * 计划依据: .qoder/plan/2026-06-26-plan-B-agent-host.md §B4
 */

import { streamSimple } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

/** 直连凭据（host 本地，注入时提供） */
export interface DirectStreamCredentials {
  /** OpenAI 兼容端点（如 http://localhost:11434/v1） */
  readonly baseUrl?: string;
  /** API key（本地 provider 常为空或占位） */
  readonly apiKey?: string;
  /** 附加请求头 */
  readonly headers?: Record<string, string>;
  /** API 格式（openai/deepseek 用）：completions 或 responses，默认 responses */
  readonly apiFormat?: 'completions' | 'responses';
}

export interface CreateDirectStreamFnOptions {
  /** host 本地凭据 */
  readonly credentials: DirectStreamCredentials;
  /** 脱敏日志 */
  readonly log?: (msg: string) => void;
  /**
   * 可选 streamSimple 注入点（仅测试用 mock provider；缺省用 pi-ai streamSimple）。
   */
  readonly streamImpl?: typeof streamSimple;
}

/**
 * 创建 direct 直连 streamFn。
 *
 * 产出的 StreamFn 遵循 pi-agent-core 契约：使用「调用时传入的模型」，
 * 把 host 本地 baseUrl 合并进 model（model.baseUrl 优先于凭据，便于按模型覆盖端点），
 * apiKey/headers 经 options 注入。
 */
export function createDirectStreamFn(opts: CreateDirectStreamFnOptions): StreamFn {
  const impl = opts.streamImpl ?? streamSimple;
  const { baseUrl, apiKey, headers, apiFormat } = opts.credentials;

  return (model, context, options) => {
    // model.baseUrl 优先（允许按模型指定端点）；否则用 host 本地默认 baseUrl。
    // api 规范化：pi-ai 只注册 openai-completions/openai-responses 等具体 provider，
    // 没有裸 "openai"。ModelRouter.inferApi 默认给 "openai"，直连本地 OpenAI 兼容
    // 端点（Ollama/LM Studio）须映射到对应 API（根据 apiFormat 选择）。
    const normalizedApi = normalizeApi(model.api, apiFormat);
    // pi-ai 的 provider 会读 model.input / cost / contextWindow 等字段
    // （如 openai-completions 里 model.input.includes("image")）。
    // ModelRouter.resolveExplicitModelId 只产出 {id, api} 最小模型——直连场景必须
    // 补全这些字段，否则 pi-ai 内部 undefined.includes 崩溃。
    const m = model as Partial<Model<string>> & { id: string };
    const effectiveModel = {
      ...model,
      provider: m.provider ?? "openai",
      reasoning: m.reasoning ?? false,
      input: m.input ?? ["text"],
      cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? 1_000_000,
      maxTokens: m.maxTokens ?? 8_192,
      name: m.name ?? m.id,
      api: normalizedApi,
      baseUrl: model.baseUrl && model.baseUrl.length > 0 ? model.baseUrl : baseUrl ?? "",
    } as Model<typeof model.api>;

    opts.log?.(
      `[direct-stream] model=${effectiveModel.id} api=${effectiveModel.api} baseUrl=${effectiveModel.baseUrl || "(none)"}`,
    );

    const mergedOptions = {
      ...options,
      // 本地 OpenAI 兼容端点（Ollama 等）通常免鉴权，但 pi-ai 的 openai-completions
      // provider 强制校验 apiKey 存在性。无 key 时填占位符让校验通过（端点会忽略它）。
      apiKey: apiKey || options?.apiKey || "local-no-key",
      ...(headers ? { headers: { ...headers, ...(options?.headers ?? {}) } } : {}),
      // 调试：拦截原始响应 payload（仅 responses API）
      onPayload: normalizedApi === "openai-responses" ? (payload: unknown) => {
        const p = payload as Record<string, unknown>;
        opts.log?.(`[direct-stream] 🔍 Request payload - model: ${p.model}, prompt_cache_key: ${p.prompt_cache_key}, messages: ${(p.input as unknown[])?.length} items`);
        options?.onPayload?.(payload);
      } : options?.onPayload,
    };

    const stream = impl(effectiveModel, context, mergedOptions);

    // 调试：拦截事件流，记录 usage 信息
    // if (normalizedApi === "openai-responses") {
    //   const originalResult = stream.result.bind(stream);
    //   stream.result = async () => {
    //     const message = await originalResult();
    //     opts.log?.(`[direct-stream] 🔍 Final message usage: ${JSON.stringify(message.usage, null, 2)}`);
    //     return message;
    //   };
    // }

    return stream;
  };
}

/** 把宽泛的 api 名规范化为 pi-ai 注册的具体 provider 名 */
function normalizeApi(api: string, apiFormat?: 'completions' | 'responses'): string {
  // 裸 "openai" → 根据 apiFormat 选择（默认 responses）
  if (api === "openai") {
    return apiFormat === "completions" ? "openai-completions" : "openai-responses";
  }
  return api;
}
