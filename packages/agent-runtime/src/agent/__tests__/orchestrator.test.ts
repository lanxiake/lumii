/**
 * AgentOrchestrator 单元测试
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentOrchestrator } from "../orchestrator.js";
import { AgentRegistry } from "../agent-registry.js";
import { MessageBus } from "../../messaging/message-bus.js";
import type { AgentDefinition } from "../../types/agent-definition.js";
import type { AgentInstance } from "../agent-instance.js";
import type { SubagentCompletionPayload } from "../subagent-broker.js";

const mockDef = (id: string): AgentDefinition => ({
  id,
  name: id,
  description: "t",
  modelTier: "basic",
  permissionMode: "default",
  systemPrompt: "x",
});

/** 构造可订阅、可 waitForIdle 的子实例 mock */
function mockChild(id: string, output = "child-out"): AgentInstance {
  return {
    id,
    subscribe: (cb: (e: { type: string; fullText?: string; delta?: string }) => void) => {
      cb({ type: "message:end", fullText: output });
      return () => {};
    },
    waitForIdle: async () => {},
  } as unknown as AgentInstance;
}

describe("AgentOrchestrator", () => {
  let registry: AgentRegistry;
  let bus: MessageBus;

  beforeEach(() => {
    registry = new AgentRegistry();
    bus = new MessageBus();
  });

  it("spawnAgent async 返回子实例 id", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const child = mockChild("child-1");
    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => "child-1",
      prompt,
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: () => child,
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
    });

    const r = await orch.spawnAgent({ name: "sub", prompt: "hello", mode: "async" }, "parent-1");
    expect(r.status).toBe("ok");
    if (r.status === "ok" && r.mode === "async") {
      expect(r.instanceId).toBe("child-1");
    }
    expect(prompt).toHaveBeenCalledWith("child-1", "hello");
  });

  it("sendMessage 向目标投递 MessageBus 并 followUp", async () => {
    const followUp = vi.fn();
    const inst2 = { id: "b1" } as unknown as AgentInstance;

    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => "x",
      prompt: vi.fn(),
      followUp,
      destroy: vi.fn(),
      getInstance: (id) => (id === "b1" ? inst2 : undefined),
      findInstanceByRecipient: () => inst2,
      getDisplayNameForInstance: (id) => id,
    });

    bus.register("b1");
    const r = await orch.sendMessage({
      to: "b1",
      message: "ping",
      fromInstanceId: "a1",
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok" && "delivered" in r) {
      expect(r.delivered).toBe(true);
    }
    expect(followUp).toHaveBeenCalledWith("b1", "ping");
    expect(bus.pendingCount("b1")).toBe(1);
  });

  it("spawn builtin:verify (sync) → 解析 VERDICT 并前置机器摘要", async () => {
    // 模拟子实例：subscribe 时立刻推送 verify 输出，waitForIdle 立即返回
    const verifyOutput =
      "### Check build\nCommand run: pnpm build\nOutput observed: ok\nResult: 失败\n\nVERDICT: FAIL";
    const childInstance = mockChild("verify-1", verifyOutput);

    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("builtin:verify"),
      createChildInstance: async () => "verify-1",
      prompt: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: () => childInstance,
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
    });

    const r = await orch.spawnAgent(
      { name: "verify", prompt: "verify my changes", agentType: "builtin:verify", mode: "sync" },
      "parent-1",
    );

    expect(r.status).toBe("ok");
    if (r.status === "ok" && r.mode === "sync") {
      expect(r.verdict).toBe("FAIL");
      expect(r.output.startsWith("[VERIFY RESULT: FAIL]")).toBe(true);
      expect(r.output).toContain(verifyOutput);
    }
  });

  it("isVerdictConsumptionEnabled=false → 不前置摘要", async () => {
    const childInstance = mockChild("verify-2", "VERDICT: PASS");

    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("builtin:verify"),
      createChildInstance: async () => "verify-2",
      prompt: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: () => childInstance,
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
      isVerdictConsumptionEnabled: () => false,
    });

    const r = await orch.spawnAgent(
      { name: "verify", prompt: "x", agentType: "builtin:verify", mode: "sync" },
      "p",
    );
    if (r.status === "ok" && r.mode === "sync") {
      expect(r.output).toBe("VERDICT: PASS");
      expect(r.verdict).toBeUndefined();
    }
  });

  it("depth>=1 再 spawn → error（MAX_SPAWN_DEPTH=1）", async () => {
    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => "c",
      prompt: vi.fn(),
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: () => undefined,
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
    });

    const r = await orch.spawnAgent(
      { name: "nested", prompt: "x", mode: "async", _spawnDepth: 1 },
      "parent-1",
    );
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.message).toContain("depth limit");
      expect(r.message).toContain("max 1");
    }
  });

  it("子实例再 spawn → 按 registry 父子链拒绝（无需显式 _spawnDepth）", async () => {
    vi.spyOn(registry, "getDepth").mockImplementation((id) => (id === "child-1" ? 1 : 0));

    const createChild = vi.fn(async () => "grandchild-1");
    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: createChild,
      prompt: vi.fn(),
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: () => undefined,
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
    });

    const r = await orch.spawnAgent(
      { name: "grandchild", prompt: "HI", mode: "async" },
      "child-1",
    );
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.message).toContain("depth limit");
    }
    expect(createChild).not.toHaveBeenCalled();
  });

  it("并发：连续 async 超过 limit → 第 N+1 个 error", async () => {
    let n = 0;
    const children = new Map<string, AgentInstance>();
    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => {
        n += 1;
        const id = `child-${n}`;
        // 永不 idle，保持 running 占槽
        children.set(
          id,
          {
            id,
            subscribe: () => () => {},
            waitForIdle: () => new Promise(() => {}),
          } as unknown as AgentInstance,
        );
        return id;
      },
      prompt: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: (id) => children.get(id),
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
      getParentMaxConcurrent: () => 1,
    });

    const r1 = await orch.spawnAgent({ name: "a", prompt: "1", mode: "async" }, "parent-1");
    expect(r1.status).toBe("ok");

    const r2 = await orch.spawnAgent({ name: "b", prompt: "2", mode: "async" }, "parent-1");
    expect(r2.status).toBe("error");
    if (r2.status === "error") {
      expect(r2.message).toContain("concurrency limit");
    }
  });

  it("async：waitForIdle 后 onAsyncSubagentComplete 被调用一次", async () => {
    const onAsync = vi.fn();
    const child = mockChild("child-async", "done-text");
    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => "child-async",
      prompt: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: () => child,
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
      onAsyncSubagentComplete: onAsync,
    });

    await orch.spawnAgent({ name: "worker", prompt: "go", mode: "async" }, "parent-1");

    await vi.waitFor(() => {
      expect(onAsync).toHaveBeenCalledTimes(1);
    });

    const payload = onAsync.mock.calls[0]![0] as SubagentCompletionPayload;
    expect(payload).toMatchObject({
      childId: "child-async",
      parentId: "parent-1",
      name: "worker",
      status: "succeeded",
      summary: "done-text",
    });
    expect(orch.broker.drainCompletions("parent-1")).toHaveLength(1);
  });

  it("listChildren / interruptChild / steerChild", async () => {
    const onAsync = vi.fn();
    const abort = vi.fn();
    const steer = vi.fn();
    const child = {
      id: "c-life",
      subscribe: () => () => {},
      waitForIdle: () => new Promise(() => {}),
      abort,
      steer,
    } as unknown as AgentInstance;

    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => "c-life",
      prompt: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: () => child,
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
      onAsyncSubagentComplete: onAsync,
    });

    await orch.spawnAgent({ name: "worker", prompt: "go", mode: "async" }, "parent-1");
    expect(orch.listChildren("parent-1")).toHaveLength(1);
    expect(orch.listChildren("parent-1")[0]?.status).toBe("running");

    const steered = orch.steerChild("parent-1", "c-life", "nudge");
    expect(steered).toEqual({ ok: true });
    expect(steer).toHaveBeenCalledWith("nudge");

    const denied = orch.interruptChild("other-parent", "c-life");
    expect(denied.ok).toBe(false);

    const interrupted = orch.interruptChild("parent-1", "c-life");
    expect(interrupted).toEqual({ ok: true });
    expect(abort).toHaveBeenCalled();
    await vi.waitFor(() => expect(onAsync).toHaveBeenCalled());
    const payload = onAsync.mock.calls[0]![0] as SubagentCompletionPayload;
    expect(payload.status).toBe("cancelled");
  });

  it("handleStaleChild → stale 完成通知", async () => {
    const onAsync = vi.fn();
    const abort = vi.fn();
    const child = {
      id: "c-stale",
      subscribe: () => () => {},
      waitForIdle: () => new Promise(() => {}),
      abort,
    } as unknown as AgentInstance;

    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => "c-stale",
      prompt: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: () => child,
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
      onAsyncSubagentComplete: onAsync,
    });

    await orch.spawnAgent({ name: "slow", prompt: "go", mode: "async" }, "parent-1");
    orch.handleStaleChild("c-stale");
    expect(abort).toHaveBeenCalled();
    expect(onAsync).toHaveBeenCalledTimes(1);
    expect((onAsync.mock.calls[0]![0] as SubagentCompletionPayload).status).toBe("stale");
  });

  it("allowedTools 含 spawn_agent → error；父工具集外 → error", async () => {
    const parent = {
      id: "parent-1",
      getTools: () => [{ name: "bash" }, { name: "read_file" }],
    } as unknown as AgentInstance;

    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => "x",
      prompt: vi.fn(),
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: (id) => (id === "parent-1" ? parent : undefined),
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
    });

    const forbidden = await orch.spawnAgent(
      { name: "a", prompt: "x", mode: "async", allowedTools: ["spawn_agent"] },
      "parent-1",
    );
    expect(forbidden.status).toBe("error");
    if (forbidden.status === "error") {
      expect(forbidden.message).toContain("spawn_agent");
    }

    const outside = await orch.spawnAgent(
      { name: "b", prompt: "x", mode: "async", allowedTools: ["write_file"] },
      "parent-1",
    );
    expect(outside.status).toBe("error");
    if (outside.status === "error") {
      expect(outside.message).toContain("write_file");
    }

    const ok = await orch.spawnAgent(
      { name: "c", prompt: "x", mode: "async", allowedTools: ["bash(git:*)"] },
      "parent-1",
    );
    expect(ok.status).toBe("ok");
  });
});
