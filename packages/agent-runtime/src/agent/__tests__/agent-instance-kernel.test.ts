import { describe, it, expect, vi } from "vitest";
import { AgentInstance } from "../agent-instance.js";
import { FakeAgentKernel } from "../../kernel/fake-agent-kernel.js";

// ---- minimal stubs for AgentInstance construction ----

function makeConfig(kernel: FakeAgentKernel) {
  return {
    id: "test-instance",
    definition: {
      id: "test-def",
      name: "test",
      description: "test agent",
      systemPrompt: "You are a test agent.",
      modelTier: "basic" as const,
      permissionMode: "default" as const,
    },
    // streamFn is never called because FakeAgentKernel handles the turn
    streamFn: vi.fn().mockRejectedValue(new Error("streamFn should not be called")),
    model: { id: "fake-model", provider: "fake", contextWindow: 8192 } as never,
    tools: [],
    kernel,
  };
}

describe("AgentInstance with FakeAgentKernel", () => {
  it("成功 turn：prompt() 正常完成，state 最终为 idle", async () => {
    const kernel = new FakeAgentKernel({ replyText: "hello from fake" });
    const instance = new AgentInstance(makeConfig(kernel));

    expect(instance.state).toBe("idle");
    await instance.prompt("go");
    // pi-agent-core 订阅不存在，state 不经过 running；只验证不挂起且正常返回
    expect(instance.state).toBe("idle");
  });

  it("origin=cloud_channel：prompt() 透传 origin，turn 正常完成", async () => {
    const kernel = new FakeAgentKernel({ replyText: "ok" });
    const instance = new AgentInstance(makeConfig(kernel));

    await instance.prompt("test", undefined, "cloud_channel");

    expect(instance.state).toBe("idle");
    // kernel 收到了 origin=cloud_channel 的 request
    expect(kernel.receivedRequests[0].origin).toBe("cloud_channel");
  });

  it("kernel 返回错误结果：prompt() 不抛出，state 保持 idle", async () => {
    const kernel = new FakeAgentKernel({ errorMessage: "LLM timeout" });
    const instance = new AgentInstance(makeConfig(kernel));

    await expect(instance.prompt("go")).resolves.toBeUndefined();
    expect(instance.state).toBe("idle");
  });

  it("kernel 取消：prompt() 正常完成，state 为 idle", async () => {
    const kernel = new FakeAgentKernel({ cancelled: true });
    const instance = new AgentInstance(makeConfig(kernel));

    await instance.prompt("go");
    expect(instance.state).toBe("idle");
  });

  it("abort() 后 state 转为 aborted", () => {
    const kernel = new FakeAgentKernel({ replyText: "never" });
    const instance = new AgentInstance(makeConfig(kernel));

    instance.abort();

    expect(instance.state).toBe("aborted");
  });

  it("destroyed 实例拒绝 prompt", async () => {
    const kernel = new FakeAgentKernel();
    const instance = new AgentInstance(makeConfig(kernel));
    instance.destroy();

    await expect(instance.prompt("hello")).rejects.toThrow("destroyed");
  });

  it("subscribe 取消后不再收到事件", async () => {
    const kernel = new FakeAgentKernel({ replyText: "hi" });
    const instance = new AgentInstance(makeConfig(kernel));

    const listener = vi.fn();
    const unsub = instance.subscribe(listener);
    unsub();

    await instance.prompt("test");
    expect(listener).not.toHaveBeenCalled();
  });

  it("FakeAgentKernel 记录 receivedRequests", async () => {
    const kernel = new FakeAgentKernel({ replyText: "a" });
    const instance = new AgentInstance(makeConfig(kernel));

    await instance.prompt("first");
    await instance.prompt("second");

    expect(kernel.receivedRequests.map((r) => r.message)).toEqual(["first", "second"]);
  });
});
