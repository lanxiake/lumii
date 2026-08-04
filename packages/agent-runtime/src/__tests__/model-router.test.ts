import { describe, it, expect } from "vitest";
import { ModelRouter } from "../llm/model-router.js";

describe("ModelRouter (purpose mode)", () => {
  it("resolve 返回 purpose 占位模型供客户端构造请求", () => {
    const r = new ModelRouter();
    const m = r.resolve("coding");
    // 占位：真实模型由服务端 CapabilityResolver 决定
    expect(m.id).toBe("coding");
    // 统一走 openai 兼容（经 gateway→LiteLLM）
    expect((m as { api: string }).api).toBe("openai");
  });

  it("resolve 空用途兜底到 chat", () => {
    const r = new ModelRouter();
    expect(r.resolve("").id).toBe("chat");
  });

  it("purposeForRequest 透传用途字符串", () => {
    expect(new ModelRouter().purposeForRequest("vision")).toBe("vision");
    expect(new ModelRouter().purposeForRequest("")).toBe("chat");
  });

  it("resolveExplicitModelId 解析 provider/model 形式取 model 段", () => {
    const r = new ModelRouter();
    expect(r.resolveExplicitModelId("deepseek/deepseek-v4-pro").id).toBe("deepseek-v4-pro");
    expect(r.resolveExplicitModelId("my-local-llama").id).toBe("my-local-llama");
  });
});
