import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Type } from "@sinclair/typebox";
import type { Model } from "@mariozechner/pi-ai";
import type { MtBotTool, ToolExecutionContext } from "../../types/tool.js";
import type { AgentDefinition } from "../../types/agent-definition.js";
import { AgentRegistry } from "../../agent/agent-registry.js";
import { PermissionMemory } from "../../security/permission-memory.js";
import { createFeatureFlags } from "../../config/feature-flags.js";
import type {
  ConfigProvider,
  EventSink,
  PermissionProvider,
  PromptContextProvider,
  StreamFnFactory,
  ResolvedModel,
} from "../types.js";
import { assembleAgent, type AssembleAgentRuntime } from "../assemble-agent.js";

const MODEL: Model<string> = { id: "m1", api: "openai", provider: "gateway" } as Model<string>;

function fakeTool(name: string): MtBotTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    category: "filesystem",
    isReadOnly: true,
    needsPermission: false,
    isEnabled: () => true,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  } as MtBotTool;
}

function def(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "a1",
    name: "Assistant",
    description: "",
    systemPrompt: "You are helpful.",
    ...over,
  } as AgentDefinition;
}

const config: ConfigProvider = {
  getProviderCredentials: () => ({ apiKey: "secret" }),
  resolveModel: (): ResolvedModel => ({ model: MODEL, providerSource: "cloud", streamFnKind: "gateway" }),
  getFeatureFlags: (over) => createFeatureFlags(over),
};

const promptContext: PromptContextProvider = {
  getSkills: async () => [],
  getCustomAgents: async () => [],
  getUserDevices: async () => [],
  getSoulContent: async () => undefined,
  getContextFiles: () => [],
  getMcpServerHints: () => [],
};

const permission: PermissionProvider = { requestPermission: async () => "allow-once" };

describe("assembleAgent", () => {
  let registry: AgentRegistry;
  let events: import("../../types/events.js").AgentRuntimeEvent[];
  let eventSink: EventSink;
  let streamFnFactory: StreamFnFactory;
  let streamFnCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new AgentRegistry();
    events = [];
    eventSink = { emit: (e) => events.push(e) };
    const fakeStream = vi.fn();
    streamFnCreate = vi.fn(() => fakeStream as never);
    streamFnFactory = { create: streamFnCreate };
  });

  afterEach(() => {
    registry.destroyAll();
  });

  function runtime(over: Partial<AssembleAgentRuntime> = {}): AssembleAgentRuntime {
    return {
      registry,
      permissionMemory: new PermissionMemory(),
      cwd: "/tmp",
      osInfo: "win32 x64",
      ...over,
    };
  }

  it("产出已注册、可用的 AgentInstance 并设置了系统提示词", async () => {
    const out = await assembleAgent(
      {
        definition: def(),
        sessionKey: "sess-1",
        config,
        eventSink,
        permission,
        promptContext,
        streamFnFactory,
        tools: [fakeTool("file_read")],
        toolContext: {} as ToolExecutionContext,
      },
      runtime(),
    );

    expect(out.instanceId).toBeTruthy();
    expect(registry.get(out.instanceId)).toBe(out.instance);
    expect(out.resolved.model.id).toBe("m1");
    expect(out.resolved.providerSource).toBe("cloud");
    expect(out.prompt.initial.fullPrompt.length).toBeGreaterThan(0);
  });

  it("purpose 图槽：用 definition.defaultPurpose 调 config.resolveModel", async () => {
    const resolveSpy = vi.spyOn(config, "resolveModel");
    await assembleAgent(
      {
        definition: def({ defaultPurpose: "coding" }),
        sessionKey: "s",
        config,
        eventSink,
        permission,
        promptContext,
        streamFnFactory,
        tools: [],
        toolContext: {} as ToolExecutionContext,
      },
      runtime(),
    );
    expect(resolveSpy).toHaveBeenCalledWith("coding", undefined);
    resolveSpy.mockRestore();
  });

  it("streamFn 工厂收到解析后的模型与上下文", async () => {
    await assembleAgent(
      {
        definition: def(),
        sessionKey: "s",
        config,
        eventSink,
        permission,
        promptContext,
        streamFnFactory,
        tools: [],
        toolContext: {} as ToolExecutionContext,
      },
      runtime(),
    );
    const [resolvedArg, ctxArg] = streamFnCreate.mock.calls[0];
    expect((resolvedArg as ResolvedModel).model.id).toBe("m1");
    expect((ctxArg as { agentId: string }).agentId).toBe("a1");
  });

  it("wrapStreamFn 被调用以包装工厂产出（per-session 覆盖场景）", async () => {
    const wrapStreamFn = vi.fn((inner) => inner);
    await assembleAgent(
      {
        definition: def(),
        sessionKey: "s",
        config,
        eventSink,
        permission,
        promptContext,
        streamFnFactory,
        tools: [],
        toolContext: {} as ToolExecutionContext,
      },
      runtime({ wrapStreamFn }),
    );
    expect(wrapStreamFn).toHaveBeenCalledTimes(1);
  });

  it("订阅 eventSink：实例事件经 sink 转发", async () => {
    const out = await assembleAgent(
      {
        definition: def(),
        sessionKey: "s",
        config,
        eventSink,
        permission,
        promptContext,
        streamFnFactory,
        tools: [],
        toolContext: {} as ToolExecutionContext,
      },
      runtime(),
    );
    // 通过实例的 subscribe 出口推一个事件（借 setSystemPrompt 不触发事件，直接验证订阅已挂上）
    const probe = { type: "agent:start" } as never;
    (out.instance as unknown as { listeners: Set<(e: unknown) => void> }).listeners.forEach((fn) => fn(probe));
    expect(events).toContain(probe);
  });

  it("dispose：取消订阅并从 registry 移除实例", async () => {
    const out = await assembleAgent(
      {
        definition: def(),
        sessionKey: "s",
        config,
        eventSink,
        permission,
        promptContext,
        streamFnFactory,
        tools: [],
        toolContext: {} as ToolExecutionContext,
      },
      runtime(),
    );
    const id = out.instanceId;
    expect(registry.get(id)).toBeDefined();
    out.dispose();
    expect(registry.get(id)).toBeUndefined();
  });

  it("modelOverride 透传给 config.resolveModel", async () => {
    const resolveSpy = vi.spyOn(config, "resolveModel");
    await assembleAgent(
      {
        definition: def(),
        sessionKey: "s",
        config,
        eventSink,
        permission,
        promptContext,
        streamFnFactory,
        tools: [],
        toolContext: {} as ToolExecutionContext,
        modelOverride: { modelRef: "deepseek/v4", providerSource: "cloud" },
      },
      runtime(),
    );
    expect(resolveSpy).toHaveBeenCalledWith("chat", { modelRef: "deepseek/v4", providerSource: "cloud" });
    resolveSpy.mockRestore();
  });
});
