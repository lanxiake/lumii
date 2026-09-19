/**
 * 模型路由 — purpose（用途）透传
 *
 * 客户端不再决定具体模型——只把 purpose 透传给 gateway，
 * 由服务端 CapabilityResolver 解析为真实模型 + 计费 + 通道。
 * fallback 交给 LiteLLM；客户端不再维护 tier→模型 的硬编码映射。
 */

import type { Model } from "@mariozechner/pi-ai";

const FALLBACK_PURPOSE = "chat";

/** 已知模型 ID → API 类型映射（仅用户本地模型直连场景需要） */
const MODEL_API_MAP: Record<string, string> = {
  "deepseek-v4-flash": "openai",
  "deepseek-v4-pro": "openai",
  "deepseek-chat": "openai",
  "deepseek-reasoner": "openai",
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "claude-sonnet-4-5": "anthropic-messages",
  "claude-haiku-4-5": "anthropic-messages",
  "gemini-2.5-pro": "google-generative-ai",
  "gemini-2.5-flash": "google-generative-ai",
};

/** 根据模型 ID 推断 API 类型（仅在宿主未给出 provider 类型时兜底） */
function inferApi(modelId: string): string {
  if (MODEL_API_MAP[modelId]) return MODEL_API_MAP[modelId]!;
  if (modelId.includes("deepseek")) return "openai";
  if (modelId.includes("claude")) return "anthropic-messages";
  if (modelId.includes("gemini")) return "google-generative-ai";
  return "openai"; // 默认 openai 兼容 API
}

/**
 * 模型路由器（用途模式）。
 *
 * resolve() 返回的 id 即 purpose 占位，api 统一 openai（经 gateway→LiteLLM）。
 * 真实模型由服务端 CapabilityResolver 根据 purpose 解析。
 */
export class ModelRouter {
  /** 将用途解析为占位 Model（id=purpose，供客户端构造请求） */
  resolve(purpose: string): Model<string> {
    return { id: purpose || FALLBACK_PURPOSE, api: "openai" } as Model<string>;
  }

  /** 供 gateway 请求体 purpose 字段使用（透传） */
  purposeForRequest(purpose: string): string {
    return purpose || FALLBACK_PURPOSE;
  }

  /**
   * 将显式模型引用解析为单次调用的 Model（用户本地模型直连场景）。
   * 支持 `providerKey/modelId`（取 modelId 段）与裸 `modelId`。
   *
   * api 优先取宿主给的 provider 类型：中转上的 `anthropic/claude-*` 走的是 OpenAI
   * 兼容协议，按模型 ID 猜 api 会被错误路由到 anthropic-messages。仅在宿主未给类型
   * 时才回退到 ID 推断。
   */
  resolveExplicitModelId(raw: string, apiOverride?: string): Model<string> {
    const trimmed = raw.trim();
    const slash = trimmed.indexOf("/");
    const id = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
    if (!id) {
      return this.resolve(FALLBACK_PURPOSE);
    }
    return { id, api: apiOverride ?? inferApi(id) } as Model<string>;
  }
}
