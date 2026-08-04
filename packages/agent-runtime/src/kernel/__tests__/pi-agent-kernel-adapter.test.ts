import { describe, it, expect, vi, beforeEach } from "vitest";
import { PiAgentKernelAdapter } from "../pi-agent-kernel-adapter.js";
import type { AgentTurnEvent } from "@mtbot/protocol";

// ---- mock pi-agent-core Agent ----

type RawListener = (event: Record<string, unknown>) => void;

function makeMockAgent() {
  const listeners: RawListener[] = [];
  const agent = {
    state: { model: { id: "test-model" } },
    subscribe: vi.fn((fn: RawListener) => {
      listeners.push(fn);
      return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    prompt: vi.fn(async (_msg: string) => {
      // 默认什么都不 emit
    }),
    abort: vi.fn(),
    emit(event: Record<string, unknown>) {
      for (const fn of [...listeners]) fn(event);
    },
  };
  return agent;
}

describe("PiAgentKernelAdapter", () => {
  let mockAgent: ReturnType<typeof makeMockAgent>;
  let adapter: PiAgentKernelAdapter;

  beforeEach(() => {
    mockAgent = makeMockAgent();
    // PiAgentKernelAdapter 构造时会调用 agent.subscribe 一次
    adapter = new PiAgentKernelAdapter(mockAgent as never);
  });

  it("getDefaultModel 返回 agent.state.model.id", () => {
    expect(adapter.getDefaultModel()).toBe("test-model");
  });

  it("listModels 返回含 isDefault=true 的数组", async () => {
    const models = await adapter.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("test-model");
    expect(models[0].isDefault).toBe(true);
  });

  it("subscribe / unsubscribe 正常工作", () => {
    const listener = vi.fn();
    const unsub = adapter.subscribe(listener);

    mockAgent.emit({ type: "agent_start" });
    expect(listener).toHaveBeenCalledOnce();

    unsub();
    mockAgent.emit({ type: "agent_start" });
    // 取消后不再触发
    expect(listener).toHaveBeenCalledOnce();
  });

  it("agent_start → turn:start 事件转发", () => {
    const events: AgentTurnEvent[] = [];
    adapter.subscribe((e) => events.push(e));

    mockAgent.emit({ type: "agent_start" });

    expect(events[0].type).toBe("turn:start");
  });

  it("message_update text_delta → turn:delta 累积文本", () => {
    const events: AgentTurnEvent[] = [];
    adapter.subscribe((e) => events.push(e));

    mockAgent.emit({ type: "agent_start" });
    mockAgent.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    mockAgent.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: " world" },
    });

    const deltas = events.filter((e) => e.type === "turn:delta") as Extract<
      AgentTurnEvent,
      { type: "turn:delta" }
    >[];
    expect(deltas[0].delta).toBe("hello");
    expect(deltas[0].fullText).toBe("hello");
    expect(deltas[1].delta).toBe(" world");
    expect(deltas[1].fullText).toBe("hello world");
  });

  it("message_update thinking_delta → turn:thinking", () => {
    const events: AgentTurnEvent[] = [];
    adapter.subscribe((e) => events.push(e));

    mockAgent.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "reasoning..." },
    });

    const thinking = events.find((e) => e.type === "turn:thinking") as Extract<
      AgentTurnEvent,
      { type: "turn:thinking" }
    >;
    expect(thinking.delta).toBe("reasoning...");
  });

  it("tool_execution_start → turn:tool_start", () => {
    const events: AgentTurnEvent[] = [];
    adapter.subscribe((e) => events.push(e));

    mockAgent.emit({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "ls" },
    });

    const toolStart = events[0] as Extract<AgentTurnEvent, { type: "turn:tool_start" }>;
    expect(toolStart.type).toBe("turn:tool_start");
    expect(toolStart.toolCallId).toBe("tc1");
    expect(toolStart.toolName).toBe("bash");
  });

  it("tool_execution_end → turn:tool_end", () => {
    const events: AgentTurnEvent[] = [];
    adapter.subscribe((e) => events.push(e));

    mockAgent.emit({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    });

    const toolEnd = events[0] as Extract<AgentTurnEvent, { type: "turn:tool_end" }>;
    expect(toolEnd.type).toBe("turn:tool_end");
    expect(toolEnd.toolCallId).toBe("tc1");
    expect(toolEnd.isError).toBe(false);
  });

  it("startTurn 调用 agent.prompt 并在 agent_end 时 resolve", async () => {
    mockAgent.prompt.mockImplementation(async () => {
      mockAgent.emit({ type: "agent_start" });
      mockAgent.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      });
      mockAgent.emit({
        type: "message_end",
        message: {
          stopReason: "endTurn",
          usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 },
        },
      });
      mockAgent.emit({ type: "agent_end" });
    });

    const result = await adapter.startTurn({ message: "hello" });

    expect(mockAgent.prompt).toHaveBeenCalledWith("hello", undefined);
    expect(result.cancelled).toBe(false);
    expect(result.fullText).toBe("hi");
  });

  it("cancelTurn 调用 agent.abort", () => {
    adapter.cancelTurn();
    expect(mockAgent.abort).toHaveBeenCalledOnce();
  });

  it("agent_start 重置 accumulatedText", async () => {
    mockAgent.prompt.mockImplementation(async () => {
      mockAgent.emit({ type: "agent_start" });
      mockAgent.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "first" },
      });
      mockAgent.emit({ type: "agent_end" });
    });
    await adapter.startTurn({ message: "run1" });

    mockAgent.prompt.mockImplementation(async () => {
      mockAgent.emit({ type: "agent_start" });
      mockAgent.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "second" },
      });
      mockAgent.emit({ type: "agent_end" });
    });

    const result2 = await adapter.startTurn({ message: "run2" });
    // 第二次 turn 的 fullText 不应包含第一次的 "first"
    expect(result2.fullText).toBe("second");
  });
});
