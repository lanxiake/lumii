import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Model } from "@mariozechner/pi-ai";
import {
  createStreamFnFactory,
  createGatewayStreamFnFactory,
  createDirectStreamFnFactory,
} from "../stream-fn-factory.js";
import type { ResolvedModel, StreamFnContext } from "../types.js";

const RESOLVED_MODEL: Model<string> = {
  id: "resolved-model",
  api: "openai",
  provider: "gateway",
} as Model<string>;

const CTX: StreamFnContext = {
  sessionKey: "sess-1",
  rootSessionKey: "root-1",
  runId: "run-1",
  purpose: "chat",
  agentId: "agent-1",
  agentName: "测试助手",
};

function gatewayResolved(): ResolvedModel {
  return { model: RESOLVED_MODEL, providerSource: "cloud", streamFnKind: "gateway" };
}

function drainProxyStream(stream: unknown): Promise<void> {
  // createProxyStream 是异步可迭代；这里只需驱动其内部 fetch 调用发生，
  // 故消费迭代器直至结束（mock fetch 返回非 ok，会以错误结束但已发起请求）
  const iterable = stream as AsyncIterable<unknown>;
  return (async () => {
    try {
      for await (const _ of iterable) {
        void _;
      }
    } catch {
      // 忽略：本测试只关心请求是否按预期构造
    }
  })();
}

describe("host-kit stream-fn-factory", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response("nope", { status: 500, statusText: "err" }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gateway 工厂忠实使用调用时传入的模型（不强制覆盖，保留外层换模能力）", async () => {
    const factory = createGatewayStreamFnFactory({
      gatewayUrl: "http://localhost:18789",
      getAuthToken: async () => "tok",
    });
    const streamFn = factory.create(gatewayResolved(), CTX);

    // 模拟 Windows 外层覆盖：以 explicit 模型调用
    const explicit = { id: "user-picked", api: "openai", provider: "x" } as Model<string>;
    const stream = streamFn(explicit, { messages: [] } as never, undefined);
    await drainProxyStream(stream);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { model: Model<string> };
    expect(body.model.id).toBe("user-picked");
  });

  it("gateway 工厂将 ctx 基础字段与宿主 extras 合并进 metadata", async () => {
    const factory = createGatewayStreamFnFactory({
      gatewayUrl: "http://localhost:18789",
      getAuthToken: async () => "tok",
      getMetadataExtras: () => ({ channel: "windows-agent-runtime", thinkingEnabled: true }),
    });
    const streamFn = factory.create(gatewayResolved(), CTX);
    const stream = streamFn(RESOLVED_MODEL, { messages: [] } as never, undefined);
    await drainProxyStream(stream);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      metadata: { sessionId: string; runId: string; purpose: string; agentId: string; channel: string; thinkingEnabled: boolean };
    };
    expect(body.metadata.sessionId).toBe("sess-1");
    expect(body.metadata.runId).toBe("run-1");
    expect(body.metadata.purpose).toBe("chat");
    expect(body.metadata.agentId).toBe("agent-1");
    expect(body.metadata.channel).toBe("windows-agent-runtime");
    expect(body.metadata.thinkingEnabled).toBe(true);
  });

  it("direct 工厂未配置时命中即抛错", () => {
    const factory = createDirectStreamFnFactory();
    expect(() =>
      factory.create(
        { model: RESOLVED_MODEL, providerSource: "local", streamFnKind: "direct" },
        CTX,
      ),
    ).toThrow(/direct stream not configured/);
  });

  it("direct 工厂配置后产出可用 streamFn（mock impl）", () => {
    const resolveCredentials = vi.fn(() => ({ baseUrl: "http://localhost:11434/v1" }));
    const factory = createDirectStreamFnFactory({ resolveCredentials });
    const fn = factory.create(
      { model: RESOLVED_MODEL, providerSource: "local", streamFnKind: "direct" },
      CTX,
    );
    expect(typeof fn).toBe("function");
    expect(resolveCredentials).toHaveBeenCalledOnce();
  });

  it("顶层工厂按 streamFnKind 分派：gateway 正常、direct 未配置抛错", async () => {
    const factory = createStreamFnFactory({
      gateway: { gatewayUrl: "http://localhost:18789", getAuthToken: async () => "tok" },
    });

    const streamFn = factory.create(gatewayResolved(), CTX);
    const stream = streamFn(RESOLVED_MODEL, { messages: [] } as never, undefined);
    await drainProxyStream(stream);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(() =>
      factory.create(
        { model: RESOLVED_MODEL, providerSource: "local", streamFnKind: "direct" },
        CTX,
      ),
    ).toThrow(/direct stream not configured/);
  });
});
