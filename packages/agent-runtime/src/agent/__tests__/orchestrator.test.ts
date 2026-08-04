/**
 * AgentOrchestrator 单元测试
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentOrchestrator } from "../orchestrator.js";
import { AgentRegistry } from "../agent-registry.js";
import { MessageBus } from "../../messaging/message-bus.js";
import type { AgentDefinition } from "../../types/agent-definition.js";
import type { AgentInstance } from "../agent-instance.js";

const mockDef = (id: string): AgentDefinition => ({
  id,
  name: id,
  description: "t",
  modelTier: "basic",
  permissionMode: "default",
  systemPrompt: "x",
});

describe("AgentOrchestrator", () => {
  let registry: AgentRegistry;
  let bus: MessageBus;

  beforeEach(() => {
    registry = new AgentRegistry();
    bus = new MessageBus();
  });

  it("spawnAgent async 返回子实例 id", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const orch = new AgentOrchestrator(registry, bus, {
      resolveDefinition: async () => mockDef("assistant"),
      createChildInstance: async () => {
        return "child-1";
      },
      prompt,
      followUp: vi.fn(),
      destroy: vi.fn(),
      getInstance: () => undefined,
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
    const childInstance = {
      id: "verify-1",
      subscribe: (cb: (e: { type: string; fullText?: string }) => void) => {
        cb({ type: "message:end", fullText: verifyOutput });
        return () => {};
      },
      waitForIdle: async () => {},
    } as unknown as AgentInstance;

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
    const childInstance = {
      id: "verify-2",
      subscribe: (cb: (e: { type: string; fullText?: string }) => void) => {
        cb({ type: "message:end", fullText: "VERDICT: PASS" });
        return () => {};
      },
      waitForIdle: async () => {},
    } as unknown as AgentInstance;

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
});
