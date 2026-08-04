import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import { CircuitBreaker } from "../policy.js";
import { groupMessagesByApiRound } from "../api-invariants.js";
import { iterativeDropUntilUnder } from "../strategies/hard-trim.js";
import { estimateTokenCount } from "../token-estimate.js";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return { role: "assistant", content: text } as AgentMessage;
}
function assistantCall(id: string): AgentMessage {
  return { role: "assistant", content: [{ type: "toolCall", id, name: "file_read", arguments: {} }] } as AgentMessage;
}
function toolResult(id: string, len = 50): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "file_read",
    content: [{ type: "text", text: "x".repeat(len) }],
  } as AgentMessage;
}

describe("CircuitBreaker — 断路器状态机", () => {
  it("连续失败达阈值即 tripped，成功后归零", () => {
    const b = new CircuitBreaker(3);
    expect(b.tripped).toBe(false);
    b.recordFailure();
    b.recordFailure();
    expect(b.failures).toBe(2);
    expect(b.tripped).toBe(false);
    b.recordFailure();
    expect(b.tripped).toBe(true);
    b.recordSuccess();
    expect(b.failures).toBe(0);
    expect(b.tripped).toBe(false);
  });

  it("阈值为 1 时单次失败即熔断", () => {
    const b = new CircuitBreaker(1);
    b.recordFailure();
    expect(b.tripped).toBe(true);
  });
});

describe("groupMessagesByApiRound — API 轮次分组", () => {
  it("以 assistant 消息为边界分组，toolResult 归入产生它的 assistant 组", () => {
    const messages = [
      user("u1"),
      assistantCall("c1"),
      toolResult("c1"),
      assistant("a1 final"),
      user("u2"),
      assistantCall("c2"),
      toolResult("c2"),
    ];
    const groups = groupMessagesByApiRound(messages);
    // 边界：u1 -> [u1] 累积直到首个 assistant 开新组
    // 组1: [u1, assistantCall(c1), toolResult(c1)] —— 第一个 assistant 在 current 非空时开组
    // 实际：current=[u1]; assistantCall→push groups[u1], current=[c1]; toolResult→push current;
    //       assistant(a1)→ current非空 push [c1,tr1], current=[a1]; u2→push; assistantCall(c2)→ current非空 push[a1,u2], current=[c2]; tr2 push
    expect(groups.length).toBe(4);
    // 每个含 toolCall 的组，其 toolResult 在同组（配对不被拆散）
    const flat = groups.flat();
    expect(flat.length).toBe(messages.length);
  });

  it("toolCall 与其 toolResult 始终在同一组（配对完整性）", () => {
    const messages = [assistantCall("c1"), toolResult("c1"), assistant("done")];
    const groups = groupMessagesByApiRound(messages);
    // 组1: [assistantCall(c1), toolResult(c1)]，组2: [assistant(done)]
    const g0 = groups[0]!;
    const hasCall = g0.some((m) => Array.isArray((m as { content?: unknown }).content));
    const hasResult = g0.some((m) => (m as { role?: string }).role === "toolResult");
    expect(hasCall && hasResult).toBe(true);
  });

  it("空数组返回空分组", () => {
    expect(groupMessagesByApiRound([])).toEqual([]);
  });
});

describe("iterativeDropUntilUnder — 轮次分组丢弃收紧到预算", () => {
  function buildLongHistory(): AgentMessage[] {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(user(`u${i}`));
      msgs.push(assistantCall(`c${i}`));
      msgs.push(toolResult(`c${i}`, 2000)); // 每条 ~600 tokens
      msgs.push(assistant(`a${i}`));
    }
    return msgs;
  }

  it("轮次模式收紧到预算内且无孤立 toolResult", () => {
    const messages = buildLongHistory();
    const budget = 3000;
    const out = iterativeDropUntilUnder(messages, budget, true);
    expect(estimateTokenCount(out)).toBeLessThanOrEqual(budget);
    // 无孤立 toolResult：每个 toolResult 前必有对应 assistant toolCall
    const callIds = new Set<string>();
    for (const m of out) {
      if ((m as { role?: string }).role === "assistant") {
        const c = (m as { content?: Array<{ type?: string; id?: string }> }).content;
        if (Array.isArray(c)) for (const b of c) if (b.type === "toolCall" && b.id) callIds.add(b.id);
      }
    }
    for (const m of out) {
      if ((m as { role?: string }).role === "toolResult") {
        const id = (m as { toolCallId?: string }).toolCallId!;
        expect(callIds.has(id)).toBe(true);
      }
    }
  });

  it("新旧实现对拍：useRoundBased true/false 都收紧到预算内", () => {
    const messages = buildLongHistory();
    const budget = 3000;
    const outNew = iterativeDropUntilUnder(messages, budget, true);
    const outLegacy = iterativeDropUntilUnder(messages, budget, false);
    expect(estimateTokenCount(outNew)).toBeLessThanOrEqual(budget);
    expect(estimateTokenCount(outLegacy)).toBeLessThanOrEqual(budget);
  });
});
