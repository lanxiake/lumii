import { describe, it, expect, vi } from "vitest";
import { SelfHealController, type SelfHealDeps } from "../self-heal.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

function errorMsg(text: string): AgentMessage {
  return { role: "assistant", stopReason: "error", errorMessage: text } as unknown as AgentMessage;
}

function makeDeps(
  messages: AgentMessage[],
  overrides: Partial<SelfHealDeps> = {},
): {
  deps: SelfHealDeps;
  replaceMessages: ReturnType<typeof vi.fn>;
  continueAgent: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  onSettled: ReturnType<typeof vi.fn>;
  state: { messages: AgentMessage[] };
} {
  const state = { messages };
  const replaceMessages = vi.fn((m: AgentMessage[]) => {
    state.messages = m;
  });
  const continueAgent = vi.fn(async () => {});
  const onError = vi.fn();
  const onSettled = vi.fn();
  const deps: SelfHealDeps = {
    instanceId: "test",
    maxRetries: 2,
    cooldownMs: 10,
    getMessages: () => state.messages,
    replaceMessages,
    appendMessage: vi.fn(),
    continueAgent,
    isDestroyed: () => false,
    isEndingPause: () => false,
    onError,
    onSettled,
    ...overrides,
  };
  return { deps, replaceMessages, continueAgent, onError, onSettled, state };
}

describe("SelfHealController", () => {
  it("最后一条非 error 时不自愈", () => {
    const { deps } = makeDeps([{ role: "assistant", stopReason: "stop" } as unknown as AgentMessage]);
    const c = new SelfHealController(deps);
    expect(c.attemptSelfHeal()).toBe(false);
  });

  it("不可恢复错误返回 false", () => {
    const { deps, continueAgent } = makeDeps([errorMsg("some random fatal error")]);
    const c = new SelfHealController(deps);
    expect(c.attemptSelfHeal()).toBe(false);
    expect(continueAgent).not.toHaveBeenCalled();
  });

  it("endingPause 时不自愈", () => {
    const { deps } = makeDeps([errorMsg("prompt is too long")], { isEndingPause: () => true });
    const c = new SelfHealController(deps);
    expect(c.attemptSelfHeal()).toBe(false);
  });

  it("超过 maxRetries 后不再自愈", () => {
    const { deps } = makeDeps([errorMsg("prompt is too long")], { maxRetries: 1 });
    const c = new SelfHealController(deps);
    expect(c.attemptSelfHeal()).toBe(true); // attempt 1
    expect(c.attemptSelfHeal()).toBe(false); // 超限
  });

  it("prompt_too_long：截断消息并 continue 重试", async () => {
    const messages: AgentMessage[] = [
      ...Array.from({ length: 9 }, (_, i) => ({ role: "user", content: `m${i}` }) as unknown as AgentMessage),
      errorMsg("prompt is too long"),
    ];
    const { deps, replaceMessages, continueAgent } = makeDeps(messages);
    const c = new SelfHealController(deps);
    expect(c.attemptSelfHeal()).toBe(true);
    expect(replaceMessages).toHaveBeenCalled();
    expect(continueAgent).toHaveBeenCalledTimes(1);
    expect(c.isHealing).toBe(true);
  });

  it("tool_pairing：修复消息序列并 continue 重试", () => {
    const { deps, replaceMessages, continueAgent } = makeDeps([
      errorMsg("tool_use ids were not found"),
    ]);
    const c = new SelfHealController(deps);
    expect(c.attemptSelfHeal()).toBe(true);
    expect(replaceMessages).toHaveBeenCalled();
    expect(continueAgent).toHaveBeenCalledTimes(1);
  });

  it("rate_limit：延迟后 continue 重试", async () => {
    vi.useFakeTimers();
    const { deps, continueAgent } = makeDeps([errorMsg("429 rate limit exceeded")]);
    const c = new SelfHealController(deps);
    expect(c.attemptSelfHeal()).toBe(true);
    expect(continueAgent).not.toHaveBeenCalled(); // 延迟中
    await vi.advanceTimersByTimeAsync(20);
    expect(continueAgent).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("continue 失败：onError + onSettled 被调用", async () => {
    const continueAgent = vi.fn(async () => {
      throw new Error("retry boom");
    });
    const { deps, onError, onSettled } = makeDeps([errorMsg("tool_use ids were not found")], {
      continueAgent,
    });
    const c = new SelfHealController(deps);
    c.attemptSelfHeal();
    // 等待 continue promise 链 settle
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("reset() 重置重试计数", () => {
    const { deps } = makeDeps([errorMsg("prompt is too long")], { maxRetries: 1 });
    const c = new SelfHealController(deps);
    expect(c.attemptSelfHeal()).toBe(true);
    expect(c.attemptSelfHeal()).toBe(false);
    c.reset();
    // reset 后可再次自愈（需重新构造 error 消息，state 已被 replaceMessages 改）
    deps.replaceMessages([errorMsg("prompt is too long")]);
    expect(c.attemptSelfHeal()).toBe(true);
  });

  describe("thinking_required 分级剥离（设计 §6.5）", () => {
    function thinkAssistant(thinking: string, text: string): AgentMessage {
      return {
        role: "assistant",
        content: [
          { type: "thinking", thinking },
          { type: "text", text },
        ],
      } as unknown as AgentMessage;
    }
    function userMsg(text: string): AgentMessage {
      return { role: "user", content: text } as unknown as AgentMessage;
    }
    function thinkingError(): AgentMessage {
      return errorMsg(
        "reasoning_content is required for the previous message in thinking mode",
      );
    }
    function hasThinking(msg: AgentMessage): boolean {
      const content = (msg as { content?: unknown }).content;
      return (
        Array.isArray(content) &&
        content.some((b) => (b as { type?: string }).type === "thinking")
      );
    }

    it("第 1 次：仅剥离历史已闭合轮的 thinking，保留当前未闭合 user 轮", () => {
      const messages: AgentMessage[] = [
        userMsg("u1"),
        thinkAssistant("old-think", "a1"),
        userMsg("u2"),
        thinkAssistant("current-think", "a2"),
        thinkingError(),
      ];
      const { deps, replaceMessages } = makeDeps(messages);
      const c = new SelfHealController(deps);
      expect(c.attemptSelfHeal()).toBe(true);
      const replaced = replaceMessages.mock.calls[0]![0] as AgentMessage[];
      // 历史轮（索引 1）thinking 被剥离；当前轮（最后一条 assistant）保留
      const historyAssistant = replaced.find(
        (m) => (m as { content?: Array<{ text?: string }> }).content?.some?.((b) => b.text === "a1"),
      )!;
      const currentAssistant = replaced.find(
        (m) => (m as { content?: Array<{ text?: string }> }).content?.some?.((b) => b.text === "a2"),
      )!;
      expect(hasThinking(historyAssistant)).toBe(false);
      expect(hasThinking(currentAssistant)).toBe(true);
    });

    it("第 2 次：兜底全量剥离所有 thinking", () => {
      const build = (): AgentMessage[] => [
        userMsg("u1"),
        thinkAssistant("old-think", "a1"),
        userMsg("u2"),
        thinkAssistant("current-think", "a2"),
        thinkingError(),
      ];
      const { deps, replaceMessages, state } = makeDeps(build(), { maxRetries: 3 });
      const c = new SelfHealController(deps);
      // 第 1 次（attempts→1，分级）
      expect(c.attemptSelfHeal()).toBe(true);
      // 模拟重试后再次 thinking_required：恢复带 error 的消息
      state.messages = build();
      // 第 2 次（attempts→2，全量）
      expect(c.attemptSelfHeal()).toBe(true);
      const lastReplaced = replaceMessages.mock.calls.at(-1)![0] as AgentMessage[];
      // 所有 assistant 的 thinking 都被剥离
      expect(lastReplaced.every((m) => !hasThinking(m))).toBe(true);
    });
  });
});
