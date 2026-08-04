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
import type { Model, Context } from "@mariozechner/pi-ai";
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

  it("api='openai' 规范化为 openai-completions（pi-ai 无裸 openai provider）", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({
      credentials: { baseUrl: "http://localhost:11434/v1" },
      streamImpl: impl,
    });

    fn(fakeModel({ api: "openai" }), fakeContext, undefined);

    expect(impl.mock.calls[0][0].api).toBe("openai-completions");
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
    expect(passed.api).toBe("openai-completions");
  });

  it("透传调用方 options（signal/temperature）", () => {
    const impl = vi.fn(() => ({}) as never);
    const fn = createDirectStreamFn({ credentials: {}, streamImpl: impl });
    const signal = new AbortController().signal;

    fn(fakeModel(), fakeContext, { signal, temperature: 0.5 } as never);

    expect(impl.mock.calls[0][2]).toMatchObject({ temperature: 0.5, signal });
  });
});
