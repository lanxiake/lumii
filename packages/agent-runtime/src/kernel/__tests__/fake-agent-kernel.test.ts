import { describe, it, expect, vi } from "vitest";
import { FakeAgentKernel } from "../fake-agent-kernel.js";
import type { AgentTurnEvent } from "@mtbot/protocol";

describe("FakeAgentKernel", () => {
  it("成功 turn 返回 fullText 并发出正确事件流", async () => {
    const kernel = new FakeAgentKernel({ replyText: "hello" });
    const events: AgentTurnEvent[] = [];
    kernel.subscribe((e) => events.push(e));

    const result = await kernel.startTurn({ message: "hi" });

    expect(result.cancelled).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.fullText).toBe("hello");

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn:start");
    expect(types.at(-1)).toBe("turn:end");

    const deltas = events.filter((e) => e.type === "turn:delta");
    expect(deltas.length).toBe(5); // "hello" = 5 chars

    const endEvent = events.find((e) => e.type === "turn:end") as Extract<
      AgentTurnEvent,
      { type: "turn:end" }
    >;
    expect(endEvent.fullText).toBe("hello");
  });

  it("注入工具调用序列", async () => {
    const kernel = new FakeAgentKernel({
      replyText: "ok",
      toolCalls: [
        {
          toolCallId: "tc1",
          toolName: "read_file",
          args: { path: "/foo" },
          result: { content: "bar" },
        },
      ],
    });
    const events: AgentTurnEvent[] = [];
    kernel.subscribe((e) => events.push(e));

    await kernel.startTurn({ message: "go" });

    const toolStart = events.find((e) => e.type === "turn:tool_start") as Extract<
      AgentTurnEvent,
      { type: "turn:tool_start" }
    >;
    const toolEnd = events.find((e) => e.type === "turn:tool_end") as Extract<
      AgentTurnEvent,
      { type: "turn:tool_end" }
    >;

    expect(toolStart.toolName).toBe("read_file");
    expect(toolStart.toolCallId).toBe("tc1");
    expect(toolEnd.toolCallId).toBe("tc1");
    expect(toolEnd.isError).toBeFalsy();
  });

  it("注入错误消息", async () => {
    const kernel = new FakeAgentKernel({ errorMessage: "LLM 超时" });
    const events: AgentTurnEvent[] = [];
    kernel.subscribe((e) => events.push(e));

    const result = await kernel.startTurn({ message: "hi" });

    expect(result.error).toBe("LLM 超时");
    expect(result.cancelled).toBe(false);

    const errEvent = events.find((e) => e.type === "turn:error") as Extract<
      AgentTurnEvent,
      { type: "turn:error" }
    >;
    expect(errEvent.error).toBe("LLM 超时");
  });

  it("cancelled=true 时返回 cancelled=true 并发出 turn:cancelled", async () => {
    const kernel = new FakeAgentKernel({ cancelled: true });
    const events: AgentTurnEvent[] = [];
    kernel.subscribe((e) => events.push(e));

    const result = await kernel.startTurn({ message: "hi" });

    expect(result.cancelled).toBe(true);
    expect(events.some((e) => e.type === "turn:cancelled")).toBe(true);
  });

  it("cancelTurn() 立即发出 turn:cancelled", async () => {
    const kernel = new FakeAgentKernel({ replyText: "long" });
    const events: AgentTurnEvent[] = [];
    kernel.subscribe((e) => events.push(e));

    kernel.cancelTurn();

    expect(events.some((e) => e.type === "turn:cancelled")).toBe(true);
  });

  it("记录 receivedRequests", async () => {
    const kernel = new FakeAgentKernel();
    await kernel.startTurn({ message: "first" });
    await kernel.startTurn({ message: "second" });
    expect(kernel.receivedRequests.map((r) => r.message)).toEqual(["first", "second"]);
  });

  it("subscribe 返回的取消函数有效", async () => {
    const kernel = new FakeAgentKernel({ replyText: "hi" });
    const listener = vi.fn();
    const unsub = kernel.subscribe(listener);
    unsub();

    await kernel.startTurn({ message: "test" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("listModels 返回 fake-model", async () => {
    const kernel = new FakeAgentKernel({ modelId: "my-model" });
    const models = await kernel.listModels();
    expect(models[0].id).toBe("my-model");
    expect(models[0].isDefault).toBe(true);
    expect(kernel.getDefaultModel()).toBe("my-model");
  });

  it("AbortSignal 已中止时视为 cancelled", async () => {
    const kernel = new FakeAgentKernel({ replyText: "never" });
    const ctrl = new AbortController();
    ctrl.abort();

    const result = await kernel.startTurn({ message: "hi", signal: ctrl.signal });
    expect(result.cancelled).toBe(true);
  });
});
