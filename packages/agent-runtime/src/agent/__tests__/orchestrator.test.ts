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

  it("sendMessage 目标空闲 → prompt 唤醒（followUp 只在运行中队列里被消费）", async () => {
    const followUp = vi.fn();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const idleTarget = { id: "b1", state: "idle" } as unknown as AgentInstance;

    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => "x",
      prompt,
      followUp,
      destroy: vi.fn(),
      getInstance: () => idleTarget,
      findInstanceByRecipient: () => idleTarget,
      getDisplayNameForInstance: (id) => id,
    });

    const r = await orch.sendMessage({ to: "b1", message: "ping", fromInstanceId: "a1" });
    expect(r.status).toBe("ok");
    expect(prompt).toHaveBeenCalledWith("b1", "ping");
    expect(followUp).not.toHaveBeenCalled();
    // 消息仍进邮箱，`message` 工具可回读
    expect(bus.pendingCount("b1")).toBe(1);
  });

  it("sendMessage 目标运行中 → followUp 排队，不打断当前回合", async () => {
    const followUp = vi.fn();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const runningTarget = { id: "b1", state: "running" } as unknown as AgentInstance;

    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => "x",
      prompt,
      followUp,
      destroy: vi.fn(),
      getInstance: () => runningTarget,
      findInstanceByRecipient: () => runningTarget,
      getDisplayNameForInstance: (id) => id,
    });

    await orch.sendMessage({ to: "b1", message: "ping", fromInstanceId: "a1" });
    expect(followUp).toHaveBeenCalledWith("b1", "ping");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("sendMessage 目标状态未知/不可投 → 保持入队不丢消息", async () => {
    const followUp = vi.fn();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const paused = { id: "b1", state: "paused" } as unknown as AgentInstance;

    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => "x",
      prompt,
      followUp,
      destroy: vi.fn(),
      getInstance: () => paused,
      findInstanceByRecipient: () => paused,
      getDisplayNameForInstance: (id) => id,
    });

    await orch.sendMessage({ to: "b1", message: "ping", fromInstanceId: "a1" });
    expect(followUp).toHaveBeenCalledWith("b1", "ping");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("sendMessage 目标不在运行 → 错误信息引导改用 spawn_agent 重新委托", async () => {
    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => "x",
      prompt: vi.fn(),
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: () => undefined,
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
    });

    const r = await orch.sendMessage({ to: "灵栖情报", message: "补充要求", fromInstanceId: "a1" });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.message).toContain("not running");
      expect(r.message).toContain("spawn_agent");
    }
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

  it("并发满时第二个 async spawn 排队直到第一个释放槽", async () => {
    let n = 0;
    let releaseFirst: (() => void) | undefined;
    const firstIdle = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const children = new Map<string, AgentInstance>();
    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => {
        n += 1;
        const id = `child-${n}`;
        children.set(
          id,
          {
            id,
            subscribe: () => () => {},
            waitForIdle: () => (id === "child-1" ? firstIdle : Promise.resolve()),
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
      spawnQueue: { pollMs: 20, maxWaitMs: 5_000 },
    });

    const r1Promise = orch.spawnAgent({ name: "a", prompt: "1", mode: "async" }, "parent-1");
    await vi.waitFor(() => expect(n).toBe(1));
    const r2Promise = orch.spawnAgent({ name: "b", prompt: "2", mode: "async" }, "parent-1");
    releaseFirst?.();
    const [r1, r2] = await Promise.all([r1Promise, r2Promise]);
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    if (r2.status === "ok" && r2.mode === "async") {
      expect(r2.queuedMs).toBeGreaterThan(0);
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

  it("未知 agentType（如 worker）按省略处理：回落 assistant 并把角色写入 prompt", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const resolveDefinition = vi.fn(async (typeKey: string) => {
      if (typeKey === "assistant") return mockDef("assistant");
      throw new Error(`unexpected type: ${typeKey}`);
    });
    const child = mockChild("child-fallback");
    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition,
      createChildInstance: async () => "child-fallback",
      prompt,
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: () => child,
      findInstanceByRecipient: () => undefined,
      getDisplayNameForInstance: (id) => id,
    });

    const r = await orch.spawnAgent(
      {
        name: "r-ch06",
        prompt: "研究并撰写 ch06 反思与自我进化",
        agentType: "worker",
        mode: "async",
      },
      "parent-1",
    );

    expect(r.status).toBe("ok");
    expect(resolveDefinition).toHaveBeenCalledWith("assistant");
    expect(resolveDefinition).not.toHaveBeenCalledWith("worker");
    if (r.status === "ok" && r.mode === "async") {
      expect(r.agentTypeNote).toContain("worker");
    }
    expect(prompt).toHaveBeenCalledWith(
      "child-fallback",
      expect.stringContaining("[Role] You are acting as: worker (r-ch06)."),
    );
    expect(prompt.mock.calls[0]![1]).toContain("研究并撰写 ch06 反思与自我进化");
  });
});

describe("composeSpawnPromptWithFallbackRole", () => {
  it("为未知类型注入角色头，已有 Role 段时不重复", async () => {
    const { composeSpawnPromptWithFallbackRole } = await import("../orchestrator.js");
    const once = composeSpawnPromptWithFallbackRole("do work", "worker", "r-ch01");
    expect(once.startsWith("[Role]")).toBe(true);
    expect(composeSpawnPromptWithFallbackRole(once, "worker", "r-ch01")).toBe(once);
  });
});
