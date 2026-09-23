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

import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { captureLLMCall } from "./prompt-capture";

/**
 * 直连时单次输出 token 兜底上限。
 *
 * 历史缺陷：agent 层（pi-agent-core）从不向 streamFn 传 maxTokens，导致 provider 用
 * 其默认输出上限（如 DeepSeek 8K）。模型写大文件时输出在 arguments 中间被硬截断，
 * 上游 pi-ai 流结束用裸 JSON.parse 解析半截 JSON，抛 "Unterminated string" → 整条
 * message 归一化为不可重试的 llm_error。
 *
 * 这里给一个显式兜底（与 BridgeSessionModelCatalog.DEFAULT_SESSION_COMPACTION
 * .outputReserveTokens 对齐），调用方仍可用 options.maxTokens 覆盖。上限再大也架不住
 * 无限长文档，故真正的大文件应由 file_write 的分段写入兜底。
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

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

/**
 * 模型能力档案（宿主按 provider 配置解析后注入）。
 *
 * 为什么需要：客户端传给 pi-ai 的是只含 {id, api} 的最小模型，而 pi-ai 只在
 * `model.reasoning === true` 时才把思考参数写进请求体，且不同 OpenAI 兼容端点
 * 认的思考参数完全不同（reasoning_effort / chat_template_kwargs / thinking）。
 */
export interface ModelThinkingProfile {
  /** 该模型是否支持思考；undefined = 按端点兜底（z.ai 视作支持） */
  readonly reasoning?: boolean;
  /** 思考参数格式；auto/undefined = 按端点推断 */
  readonly thinkingFormat?: 'auto' | 'openai' | 'qwen' | 'zai';
  /** 覆盖模型输出上限兜底值 */
  readonly maxTokens?: number;
}

export interface CreateDirectStreamFnOptions {
  /** host 本地凭据 */
  readonly credentials: DirectStreamCredentials;
  /** 脱敏日志 */
  readonly log?: (msg: string) => void;
  /** 按模型解析能力档案（provider 配置注入）；缺省走原兜底逻辑 */
  readonly resolveModelProfile?: (modelId: string) => ModelThinkingProfile | undefined;
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
    const profile = opts.resolveModelProfile?.(m.id) ?? {};
    // z.ai 端点服务端默认开启思考，且其「显式关闭」分支依赖 model.reasoning 为真
    // （置 false 会导致该分支被跳过，反而回到服务端默认思考），故 zai-like 一律支持思考。
    const isZaiLike =
      m.provider === 'zai' ||
      ((m.baseUrl ?? baseUrl ?? '') as string).includes('api.z.ai');
    const thinkingFormat = resolveThinkingFormat(profile.thinkingFormat, isZaiLike);
    const reasoningSupported = m.reasoning ?? profile.reasoning ?? isZaiLike;
    const effectiveModel = {
      ...model,
      provider: m.provider ?? "openai",
      reasoning: reasoningSupported,
      input: m.input ?? ["text"],
      cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? 1_000_000,
      maxTokens: m.maxTokens ?? profile.maxTokens ?? defaultModelMaxTokens(normalizedApi),
      name: m.name ?? m.id,
      api: normalizedApi,
      baseUrl: model.baseUrl && model.baseUrl.length > 0 ? model.baseUrl : baseUrl ?? "",
      compat: buildCompat(m.compat, thinkingFormat, profile.thinkingFormat, reasoningSupported),
    } as Model<typeof model.api>;

    opts.log?.(
      `[direct-stream] model=${effectiveModel.id} api=${effectiveModel.api} baseUrl=${effectiveModel.baseUrl || "(none)"} reasoning=${reasoningSupported} format=${thinkingFormat}`,
    );

    const callerOnPayload = options?.onPayload;
    const reasoningLevel = options?.reasoning;
    // 预算压缩：anthropic/google 等按 token 预算控思考，且要求 max_tokens > 思考预算，
    // 否则 pi-ai 会把预算压回 0（simple-options.adjustMaxTokensForThinking）。
    const baseMaxTokens = options?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const thinkingBudget = isTokenBudgetApi(normalizedApi)
      ? budgetForLevel(reasoningLevel, options?.thinkingBudgets)
      : 0;
    const mergedOptions = {
      ...options,
      // 本地 OpenAI 兼容端点（Ollama 等）通常免鉴权，但 pi-ai 的 openai-completions
      // provider 强制校验 apiKey 存在性。无 key 时填占位符让校验通过（端点会忽略它）。
      apiKey: apiKey || options?.apiKey || "local-no-key",
      // 兜底单次输出上限：调用方未显式指定时补齐，避免 provider 默认上限截断大文件写入
      // （否则 arguments 半截 JSON → 上游裸 JSON.parse 抛错 → 不可重试 llm_error）。
      maxTokens:
        thinkingBudget > 0
          ? Math.max(baseMaxTokens, thinkingBudget + DEFAULT_MAX_OUTPUT_TOKENS)
          : baseMaxTokens,
      ...(headers ? { headers: { ...headers, ...(options?.headers ?? {}) } } : {}),
      onPayload: (payload: unknown) => {
        injectThinkingParams(payload, normalizedApi, thinkingFormat, reasoningLevel, effectiveModel.baseUrl);
        if (normalizedApi === "openai-responses") {
          const p = payload as Record<string, unknown>;
          opts.log?.(
            `[direct-stream] 🔍 Request payload - model: ${p.model}, prompt_cache_key: ${p.prompt_cache_key}, messages: ${(p.input as unknown[])?.length} items`,
          );
        }
        // 新版签名是 (payload, model)：多出的 model 供回调判断来源，
        // 返回值可替换 payload（本仓的回调不返回，行为不变）
        callerOnPayload?.(payload, effectiveModel);
      },
    };

    const stream = impl(effectiveModel, context, mergedOptions);

    // 提示词捕获（默认关闭，见 prompt-capture.ts）。fire-and-forget 调 result() 收尾，
    // 与调用方/审计日志的 result() 共用同一个 finalResultPromise，幂等无副作用。
    const capture = captureLLMCall({ model: effectiveModel, context, options: mergedOptions });
    if (capture) {
      void Promise.resolve(stream)
        .then((s) => s.result())
        .then((msg: { content?: unknown; usage?: unknown; stopReason?: string; errorMessage?: string }) => {
          const text = extractCapturedText(msg?.content);
          capture.finish({
            text,
            usage: msg?.usage,
            stopReason: msg?.stopReason,
            errorMessage: msg?.errorMessage,
          });
        })
        .catch((err: unknown) => {
          capture.finish({ text: '', errorMessage: err instanceof Error ? err.message : String(err) });
        });
    }

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
  // 历史别名：pi-ai 注册名是 google-generative-ai，ModelRouter 曾产出 google-genai
  if (api === "google-genai") return "google-generative-ai";
  return api;
}

/** 归一思考参数格式：auto/缺省时按端点推断（z.ai 走 thinking，其余走 reasoning_effort） */
function resolveThinkingFormat(
  explicit: ModelThinkingProfile['thinkingFormat'],
  isZaiLike: boolean,
): 'openai' | 'qwen' | 'zai' {
  if (explicit === 'openai' || explicit === 'qwen' || explicit === 'zai') return explicit;
  return isZaiLike ? 'zai' : 'openai';
}

/** 各 API 家族的模型输出上限兜底（Anthropic/Gemini 真实上限远高于旧值 8192） */
function defaultModelMaxTokens(api: string): number {
  if (api === 'anthropic-messages') return 64_000;
  if (api.startsWith('google')) return 65_536;
  return 8_192;
}

/** 按 token 预算控思考的 API 家族（其余家族是档位语义） */
function isTokenBudgetApi(api: string): boolean {
  return (
    api === 'anthropic-messages' || api.startsWith('google') || api === 'bedrock-converse-stream'
  );
}

/** 取该档位生效的思考预算（pi-ai 对 xhigh 先 clamp 成 high 再查表） */
function budgetForLevel(
  level: string | undefined,
  budgets: { minimal?: number; low?: number; medium?: number; high?: number } | undefined,
): number {
  if (!level) return 0;
  const key = level === 'xhigh' ? 'high' : level;
  const value = (budgets as Record<string, number | undefined> | undefined)?.[key];
  return typeof value === 'number' && value > 0 ? value : 0;
}

/**
 * 合成 compat：显式格式优先于 pi-ai 的 URL 探测；合成 reasoning 时保持 system 角色
 * （pi-ai 在 model.reasoning 为真时改用 developer 角色，自建中转多半不认）。
 */
function buildCompat(
  existing: unknown,
  thinkingFormat: 'openai' | 'qwen' | 'zai',
  explicit: ModelThinkingProfile['thinkingFormat'],
  reasoningSupported: boolean,
): Record<string, unknown> {
  const compat: Record<string, unknown> = {
    ...((existing as Record<string, unknown> | undefined) ?? {}),
  };
  if (thinkingFormat === 'zai') compat.thinkingFormat = 'zai';
  else if (explicit === 'openai') compat.thinkingFormat = 'openai';
  if (reasoningSupported && compat.supportsDeveloperRole === undefined) {
    compat.supportsDeveloperRole = false;
  }
  return compat;
}

/** 按端点格式注入思考参数（pi-ai 只自带 openai/zai 两种） */
function injectThinkingParams(
  payload: unknown,
  api: string,
  format: 'openai' | 'qwen' | 'zai',
  reasoning: unknown,
  baseUrl: string,
): void {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as Record<string, unknown>;
  if (format === 'qwen' && api === 'openai-completions') {
    // vLLM/SGLang 系（含百炼兼容模式）：服务端默认开思考，必须显式关；
    // 且部分端点只认 low/medium/xhigh 档位，发 reasoning_effort:"high" 会 400。
    delete p.reasoning_effort;
    p.chat_template_kwargs = {
      ...((p.chat_template_kwargs as Record<string, unknown> | undefined) ?? {}),
      enable_thinking: Boolean(reasoning),
    };
  }
  if (api === 'openai-responses' && !baseUrl.includes('api.openai.com')) {
    normalizeResponsesRoles(p);
  }
}

/**
 * responses 路径没有 compat 逃生口：model.reasoning 为真时 pi-ai 无条件把 system
 * 提示词改成 developer 角色（gpt-5 系未请求思考时还会塞 "# Juice: 0" 消息），
 * 自建中转不认识 developer 会直接 400。这里归一为 system 并丢弃 Juice 提示。
 */
function normalizeResponsesRoles(p: Record<string, unknown>): void {
  const input = p.input;
  if (!Array.isArray(input)) return;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i] as { role?: string; content?: unknown } | undefined;
    if (!item || item.role !== 'developer') continue;
    if (JSON.stringify(item.content ?? '').includes('Juice:')) {
      input.splice(i, 1);
      continue;
    }
    item.role = 'system';
  }
}

/** 从 AssistantMessage.content 提取纯文本（供提示词捕获落盘） */
function extractCapturedText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { text?: string } =>
        !!c && typeof c === "object" && (c as { type?: string }).type === "text",
    )
    .map((c) => c.text ?? "")
    .join("");
}
