import { describe, it, expect, vi } from "vitest";
import type { Model } from "@mariozechner/pi-ai";
import { createStreamFnFactory, createDirectStreamFnFactory } from "../stream-fn-factory.js";
import type { ResolvedModel, StreamFnContext } from "../types.js";

const RESOLVED_MODEL: Model<string> = {
  id: "resolved-model",
  api: "openai",
  provider: "local",
} as Model<string>;

const CTX: StreamFnContext = {
  sessionKey: "sess-1",
  rootSessionKey: "root-1",
  runId: "run-1",
  purpose: "chat",
  agentId: "agent-1",
  agentName: "测试助手",
};

function localResolved(): ResolvedModel {
  return { model: RESOLVED_MODEL, providerSource: "local" };
}

describe("host-kit stream-fn-factory", () => {
  it("direct 工厂按 resolved 解析凭据并产出可用 streamFn", () => {
    const resolveCredentials = vi.fn(() => ({ baseUrl: "http://localhost:11434/v1" }));
    const factory = createDirectStreamFnFactory({ resolveCredentials });
    const fn = factory.create(localResolved(), CTX);
    expect(typeof fn).toBe("function");
    expect(resolveCredentials).toHaveBeenCalledOnce();
  });

  it("顶层工厂即为 direct 工厂", () => {
    const factory = createStreamFnFactory({
      resolveCredentials: () => ({ baseUrl: "http://localhost:11434/v1" }),
    });
    const fn = factory.create(localResolved(), CTX);
    expect(typeof fn).toBe("function");
  });
});
