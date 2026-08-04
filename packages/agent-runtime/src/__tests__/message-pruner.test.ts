/**
 * message-pruner 纯函数单测
 *
 * 覆盖 DeepSeek 思考模式裁剪规则（设计 §6.3）：
 * - 当前未闭合 user 轮：始终保留 thinking
 * - 历史轮有 toolCall：保留 thinking
 * - 历史轮无 toolCall：剥离 thinking
 * - aggressive：历史轮一律剥离
 */

import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { pruneThinkingForDeepSeek, sliceTurns } from "../agent/message-pruner.js";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

/** assistant，可含 text / thinking / toolCall block */
function assistant(opts: {
  text?: string;
  thinking?: string;
  toolCallId?: string;
}): AgentMessage {
  const content: Array<Record<string, unknown>> = [];
  if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking });
  if (opts.text) content.push({ type: "text", text: opts.text });
  if (opts.toolCallId)
    content.push({ type: "toolCall", id: opts.toolCallId, name: "bash", arguments: {} });
  return { role: "assistant", content, timestamp: 0 } as AgentMessage;
}

function toolResult(toolCallId: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    timestamp: 0,
  } as AgentMessage;
}

function hasThinking(msg: AgentMessage): boolean {
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content) && content.some((b) => (b as { type?: string }).type === "thinking");
}

describe("sliceTurns", () => {
  it("以 user 为分界切轮，首条非 user 归入第一轮", () => {
    const msgs = [
      assistant({ text: "orphan" }),
      user("u1"),
      assistant({ text: "a1" }),
      user("u2"),
      assistant({ text: "a2" }),
    ];
    const turns = sliceTurns(msgs);
    expect(turns).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 3 },
      { start: 3, end: 5 },
    ]);
  });

  it("空数组返回单个空轮", () => {
    expect(sliceTurns([])).toEqual([{ start: 0, end: 0 }]);
  });
});

describe("pruneThinkingForDeepSeek", () => {
  it("policy=off 原样返回（同一引用）", () => {
    const msgs = [user("u1"), assistant({ thinking: "t", text: "a1" })];
    expect(pruneThinkingForDeepSeek(msgs, "off")).toBe(msgs);
  });

  it("当前未闭合 user 轮的 thinking 始终保留", () => {
    const msgs = [user("u1"), assistant({ thinking: "current-think", text: "a1" })];
    const out = pruneThinkingForDeepSeek(msgs, "deepseek");
    expect(hasThinking(out[1]!)).toBe(true);
  });

  it("历史轮无 toolCall → 剥离 thinking", () => {
    const msgs = [
      user("u1"),
      assistant({ thinking: "old-think", text: "a1" }),
      user("u2"),
      assistant({ thinking: "current", text: "a2" }),
    ];
    const out = pruneThinkingForDeepSeek(msgs, "deepseek");
    expect(hasThinking(out[1]!)).toBe(false); // 历史轮剥离
    expect(hasThinking(out[3]!)).toBe(true); // 当前轮保留
  });

  it("历史轮有 toolCall → 保留 thinking（DeepSeek 跨轮要求）", () => {
    const msgs = [
      user("u1"),
      assistant({ thinking: "think-with-tool", toolCallId: "tc1" }),
      toolResult("tc1", "result"),
      assistant({ thinking: "think2", text: "a1" }),
      user("u2"),
      assistant({ thinking: "current", text: "a2" }),
    ];
    const out = pruneThinkingForDeepSeek(msgs, "deepseek");
    expect(hasThinking(out[1]!)).toBe(true); // 有 toolCall 的轮，全保留
    expect(hasThinking(out[3]!)).toBe(true);
    expect(hasThinking(out[5]!)).toBe(true); // 当前轮
  });

  it("aggressive 模式：历史轮一律剥离（即使有 toolCall）", () => {
    const msgs = [
      user("u1"),
      assistant({ thinking: "think-with-tool", toolCallId: "tc1" }),
      toolResult("tc1", "result"),
      user("u2"),
      assistant({ thinking: "current", text: "a2" }),
    ];
    const out = pruneThinkingForDeepSeek(msgs, "aggressive");
    expect(hasThinking(out[1]!)).toBe(false); // aggressive 剥离
    expect(hasThinking(out[4]!)).toBe(true); // 当前轮仍保留
  });

  it("不修改原始 messages 引用（剥离时返回新数组，原数组 thinking 仍在）", () => {
    const msgs = [
      user("u1"),
      assistant({ thinking: "old", text: "a1" }),
      user("u2"),
      assistant({ text: "a2" }),
    ];
    const out = pruneThinkingForDeepSeek(msgs, "deepseek");
    expect(out).not.toBe(msgs);
    expect(hasThinking(msgs[1]!)).toBe(true); // 原始未变
    expect(hasThinking(out[1]!)).toBe(false); // 新数组已剥离
  });

  it("无 thinking 可剥离时返回原引用", () => {
    const msgs = [user("u1"), assistant({ text: "a1" }), user("u2"), assistant({ text: "a2" })];
    expect(pruneThinkingForDeepSeek(msgs, "deepseek")).toBe(msgs);
  });
});
