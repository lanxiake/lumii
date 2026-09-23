/**
 * direct-stream 单测 — 本地/自定义 provider 直连
 *
 * 用 mock streamImpl 验证：
 *  - host 本地 baseUrl/apiKey/headers 正确注入
 *  - model.baseUrl 优先于凭据 baseUrl
 *  - 遵循 streamFn 契约（透传 context/options）
 *
 * 计划依据: .qoder/plan/2026-06-26-plan-B-agent-host.md §B4 验证
 */

import { describe, it, expect, vi } from "vitest";
import type { Model, Context } from "@earendil-works/pi-ai/compat";
import { createDirectStreamFn } from "../llm/direct-stream.js";

function fakeModel(overrides: Partial<Model<"openai-completions">> & { api?: string } = {}): Model<"openai-completions"> {
  return {
    id: "llama3",
    name: "llama3",
    api: "openai-completions",
    provider: "openai" as Model<"openai-completions">["provider"],
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
    ...overrides,
  } as Model<"openai-completions">;
}

const fakeContext = { messages: [] } as unknown as Context;

describe("createDirectStreamFn", () => {
  it("注入 host 本地 baseUrl 到无 baseUrl 的 model", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://localhost:11434/v1", apiKey: "local-key" },
      streamImpl: impl,
    });

    fn(fakeModel(), fakeContext, undefined);

    const [model, ctx, options] = impl.mock.calls[0];
    expect(model.baseUrl).toBe("http://localhost:11434/v1");
    expect(ctx).toBe(fakeContext);
    expect(options?.apiKey).toBe("local-key");
  });

  it("model.baseUrl 优先于凭据 baseUrl", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://fallback/v1" },
      streamImpl: impl,
    });

    fn(fakeModel({ baseUrl: "http://model-specific/v1" }), fakeContext, undefined);

    expect(impl.mock.calls[0][0].baseUrl).toBe("http://model-specific/v1");
  });

  it("合并 headers（凭据 + 调用方 options）", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { headers: { "X-Host": "1" } },
      streamImpl: impl,
    });

    fn(fakeModel(), fakeContext, { headers: { "X-Call": "2" } } as never);

    const headers = impl.mock.calls[0][2]?.headers;
    expect(headers).toMatchObject({ "X-Host": "1", "X-Call": "2" });
  });

  it("无 apiKey 时填占位符（本地端点免鉴权，但 pi-ai 校验 key 存在）", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://localhost:11434/v1" },
      streamImpl: impl,
    });

    fn(fakeModel(), fakeContext, undefined);

    expect(impl.mock.calls[0][2]?.apiKey).toBe("local-no-key");
  });

  it("api='openai' 默认规范化为 openai-responses（支持缓存）", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://localhost:11434/v1" },
      streamImpl: impl,
    });

    fn(fakeModel({ api: "openai" }), fakeContext, undefined);

    expect(impl.mock.calls[0][0].api).toBe("openai-responses");
  });

  it("补全最小模型的缺失字段（ModelRouter 只产 {id,api}，pi-ai 需 input/cost 等）", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://localhost:11434/v1" },
      streamImpl: impl,
    });

    // 模拟 ModelRouter.resolveExplicitModelId 的最小模型（只有 id+api+baseUrl）
    const minimal = { id: "deepseek-v4-flash", api: "openai", baseUrl: "" } as never;
    fn(minimal, fakeContext, undefined);

    const passed = impl.mock.calls[0][0] as Record<string, unknown>;
    expect(passed.input).toEqual(["text"]); // 补全：否则 pi-ai model.input.includes 崩
    expect(passed.cost).toBeDefined();
    expect(passed.contextWindow).toBeGreaterThan(0);
    expect(passed.maxTokens).toBeGreaterThan(0);
    expect(passed.api).toBe("openai-responses"); // 默认 responses
  });

  it("透传调用方 options（signal/temperature）", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({ credentials: {}, streamImpl: impl });
    const signal = new AbortController().signal;

    fn(fakeModel(), fakeContext, { signal, temperature: 0.5 } as never);

    expect(impl.mock.calls[0][2]).toMatchObject({ temperature: 0.5, signal });
  });

  it("未显式指定 maxTokens 时补齐兜底上限（防大文件写入被 provider 默认值截断）", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({ credentials: {}, streamImpl: impl });

    fn(fakeModel(), fakeContext, undefined);

    expect(impl.mock.calls[0][2]?.maxTokens).toBe(16_384);
  });

  it("调用方显式 maxTokens 优先于兜底上限", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({ credentials: {}, streamImpl: impl });

    fn(fakeModel(), fakeContext, { maxTokens: 800 } as never);

    expect(impl.mock.calls[0][2]?.maxTokens).toBe(800);
  });

  it("apiFormat='responses' → openai-responses API", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://localhost:11434/v1", apiFormat: "responses" },
      streamImpl: impl,
    });

    fn(fakeModel({ api: "openai" }), fakeContext, undefined);

    expect(impl.mock.calls[0][0].api).toBe("openai-responses");
  });

  it("apiFormat='completions' → openai-completions API", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://localhost:11434/v1", apiFormat: "completions" },
      streamImpl: impl,
    });

    fn(fakeModel({ api: "openai" }), fakeContext, undefined);

    expect(impl.mock.calls[0][0].api).toBe("openai-completions");
  });

  it("apiFormat 缺省时默认 responses", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://localhost:11434/v1" },
      streamImpl: impl,
    });

    fn(fakeModel({ api: "openai" }), fakeContext, undefined);

    expect(impl.mock.calls[0][0].api).toBe("openai-responses");
  });
});

describe("resolveModelProfile 注入", () => {
  /** 取 mock impl 收到的 (model, context, options) */
  function callWith(
    profile: Parameters<typeof createDirectStreamFn>[0]["resolveModelProfile"],
    modelOverrides: Record<string, unknown> = {},
    options: Record<string, unknown> | undefined = undefined,
  ) {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://relay.example/v1", apiFormat: "completions" },
      resolveModelProfile: profile,
      streamImpl: impl,
    });
    fn(fakeModel(modelOverrides as never), fakeContext, options as never);
    const [model, , opts] = impl.mock.calls[0];
    return { model: model as Record<string, unknown>, options: opts as Record<string, unknown> };
  }

  it("profile.reasoning=true 时合成 model.reasoning，并压回 system 角色", () => {
    const { model } = callWith(() => ({ reasoning: true, thinkingFormat: "qwen" }), {
      reasoning: undefined,
      api: "openai",
      provider: "openai",
    });

    expect(model.reasoning).toBe(true);
    expect((model.compat as Record<string, unknown>).supportsDeveloperRole).toBe(false);
  });

  it("保留宿主已有的 compat 字段（不整体替换）", () => {
    const { model } = callWith(
      () => ({ reasoning: true }),
      { reasoning: undefined, compat: { supportsStore: false } },
    );

    const compat = model.compat as Record<string, unknown>;
    expect(compat.supportsStore).toBe(false);
    expect(compat.supportsDeveloperRole).toBe(false);
  });

  it("显式 openai 格式会覆盖 pi-ai 对 z.ai 地址的自动探测", () => {
    const { model } = callWith(() => ({ thinkingFormat: "openai" }), {
      baseUrl: "https://api.z.ai/api/paas/v4",
      api: "openai-completions",
    });

    expect((model.compat as Record<string, unknown>).thinkingFormat).toBe("openai");
  });

  it("anthropic 家族模型输出上限抬到 64000（否则思考预算会被压回）", () => {
    const { model } = callWith(() => ({ reasoning: true }), {
      id: "claude-sonnet-4-5",
      api: "anthropic-messages",
      maxTokens: undefined,
      reasoning: undefined,
    });

    expect(model.maxTokens).toBe(64_000);
    expect(model.reasoning).toBe(true);
  });

  it("google 家族模型输出上限抬到 65536，并修正 google-genai 别名", () => {
    const { model } = callWith(() => ({ reasoning: true }), {
      id: "gemini-2.5-pro",
      api: "google-genai",
      maxTokens: undefined,
    });

    expect(model.api).toBe("google-generative-ai");
    expect(model.maxTokens).toBe(65_536);
  });

  it("预算型 provider 且给了思考预算时抬高 maxTokens（预算必须小于 max_tokens）", () => {
    const { options } = callWith(
      () => ({ reasoning: true }),
      { id: "claude-sonnet-4-5", api: "anthropic-messages" },
      { reasoning: "high", thinkingBudgets: { high: 32768 }, maxTokens: 16_384 },
    );

    expect(options.maxTokens).toBe(32_768 + 16_384);
  });

  it("非预算型 provider 不受思考预算影响（OpenAI 系是档位语义）", () => {
    const { options } = callWith(
      () => ({ reasoning: true }),
      { api: "openai-completions" },
      { reasoning: "high", thinkingBudgets: { high: 32768 }, maxTokens: 16_384 },
    );

    expect(options.maxTokens).toBe(16_384);
  });
});

describe("onPayload 注入", () => {
  function payloadAfter(
    format: "auto" | "openai" | "qwen" | "zai",
    apiFormat: "completions" | "responses",
    options: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
    modelOverrides: Record<string, unknown> = {},
  ) {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://relay.example/v1", apiFormat },
      resolveModelProfile: () => ({ reasoning: true, thinkingFormat: format }),
      streamImpl: impl,
    });
    fn(fakeModel({ reasoning: undefined, api: "openai", ...modelOverrides } as never), fakeContext, options as never);
    const opts = impl.mock.calls[0][2] as { onPayload?: (p: unknown) => void };
    opts.onPayload?.(payload);
    return payload;
  }

  it("qwen 格式：thinking 开 → 注入 chat_template_kwargs.enable_thinking=true，删掉 reasoning_effort", () => {
    const payload = payloadAfter("qwen", "completions", { reasoning: "high" }, {
      model: "Qwen3.8-Flash-Next",
      reasoning_effort: "high",
    });

    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.chat_template_kwargs).toMatchObject({ enable_thinking: true });
  });

  it("qwen 格式：thinking 关 → enable_thinking=false（服务端默认开，必须显式关）", () => {
    const payload = payloadAfter("qwen", "completions", {}, { model: "qwen3" });

    expect(payload.chat_template_kwargs).toMatchObject({ enable_thinking: false });
  });

  it("qwen 格式不影响 responses 路径", () => {
    const payload = payloadAfter("qwen", "responses", { reasoning: "high" }, { model: "qwen3" });

    expect(payload.chat_template_kwargs).toBeUndefined();
  });

  it("responses 非官方端点：developer 角色归一为 system，并丢弃 Juice 提示", () => {
    const payload = payloadAfter("openai", "responses", { reasoning: "high" }, {
      model: "gpt-5.6-terra",
      input: [
        { role: "system", content: "sys" },
        { role: "developer", content: [{ type: "input_text", text: "# Juice: 0 !important" }] },
        { role: "developer", content: "prompt" },
      ],
    });

    const roles = (payload.input as { role: string }[]).map((i) => i.role);
    expect(roles).toEqual(["system", "system"]);
  });

  it("responses 官方 OpenAI 端点保留 developer 角色，不做改写", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "https://api.openai.com/v1", apiFormat: "responses" },
      resolveModelProfile: () => ({ reasoning: true }),
      streamImpl: impl,
    });
    fn(fakeModel({ reasoning: undefined, api: "openai" } as never), fakeContext, undefined);
    const opts = impl.mock.calls[0][2] as { onPayload?: (p: unknown) => void };
    const payload = {
      input: [{ role: "developer", content: "prompt" }],
    };
    opts.onPayload?.(payload);

    expect((payload.input[0] as { role: string }).role).toBe("developer");
  });

  it("调用方自己的 onPayload 仍会被调用", () => {
    const impl = vi.fn(() => ({}) as never);
    const callerOnPayload = vi.fn();
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://relay.example/v1", apiFormat: "completions" },
      resolveModelProfile: () => ({ reasoning: true, thinkingFormat: "qwen" }),
      streamImpl: impl,
    });
    fn(fakeModel({ reasoning: undefined, api: "openai" } as never), fakeContext, {
      onPayload: callerOnPayload,
    } as never);
    const opts = impl.mock.calls[0][2] as { onPayload?: (p: unknown) => void };
    opts.onPayload?.({ model: "qwen3", reasoning_effort: "high" });

    expect(callerOnPayload).toHaveBeenCalledTimes(1);
    expect((callerOnPayload.mock.calls[0][0] as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });
});
