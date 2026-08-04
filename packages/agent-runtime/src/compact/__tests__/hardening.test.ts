import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import { createTransformContext } from "../transform-context.js";
import {
  stripAllOrphanToolResults,
  stripLeadingOrphanToolResults,
  validateAndRepairMessageSequence,
  readMessageRole,
} from "../api-invariants.js";
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
function image(): AgentMessage {
  return { role: "user", content: [{ type: "image", data: "base64data" }] } as AgentMessage;
}

function cfg(overrides = {}) {
  return {
    contextWindow: 10_000,
    triggerRatio: 0.9,
    keepRecentTurns: 4,
    outputReserveTokens: 500,
    summaryReserveTokens: 500,
    ...overrides,
  };
}

/** 断言序列无孤立 toolResult（核心不变量） */
function assertNoOrphanToolResult(messages: AgentMessage[]): void {
  const callIds = new Set<string>();
  for (const m of messages) {
    if (readMessageRole(m) === "assistant") {
      const c = (m as { content?: Array<{ type?: string; id?: string }> }).content;
      if (Array.isArray(c)) for (const b of c) if (b.type === "toolCall" && b.id) callIds.add(b.id);
    }
  }
  for (const m of messages) {
    if (readMessageRole(m) === "toolResult") {
      const id = (m as { toolCallId?: string }).toolCallId;
      if (id) expect(callIds.has(id)).toBe(true);
    }
  }
}

describe("B5 边界与退化场景 — 不抛错、不死循环、收敛", () => {
  it("空消息数组原样返回", async () => {
    const transform = createTransformContext(cfg());
    expect(await transform([], undefined)).toEqual([]);
  });

  it("单条消息不触发压缩", async () => {
    const transform = createTransformContext(cfg());
    const out = await transform([user("hi")], undefined);
    expect(out.length).toBe(1);
  });

  it("全为 toolResult（无 assistant toolCall）：剥离孤立后不崩", async () => {
    const transform = createTransformContext(cfg());
    const messages = [toolResult("a"), toolResult("b"), toolResult("c")];
    const out = await transform(messages, undefined);
    assertNoOrphanToolResult(out);
  });

  it("超大单条 toolResult：硬截断收敛到预算且配对完整", async () => {
    const messages: AgentMessage[] = [
      user("task"),
      assistantCall("big"),
      toolResult("big", 200_000), // 巨型结果
      assistant("done"),
    ];
    const transform = createTransformContext(
      cfg({ generateSummary: async () => "<summary>s</summary>" }),
    );
    const out = await transform(messages, undefined);
    assertNoOrphanToolResult(out);
    expect(out.length).toBeGreaterThan(0);
  });

  it("全是图片消息：剥离图片不崩", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) messages.push(image());
    const transform = createTransformContext(
      cfg({ generateSummary: async () => "<summary>s</summary>" }),
    );
    const out = await transform(messages, undefined);
    expect(out.length).toBeGreaterThan(0);
  });

  it("超长含工具循环历史：压缩后无孤立 toolResult", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(user(`u${i}`));
      messages.push(assistantCall(`c${i}`));
      messages.push(toolResult(`c${i}`, 2000));
      messages.push(assistant(`a${i}`));
    }
    const transform = createTransformContext(
      cfg({ generateSummary: async () => "<summary>s</summary>" }),
    );
    const out = await transform(messages, undefined);
    assertNoOrphanToolResult(out);
  });
});

describe("B5 abort 路径", () => {
  it("已 abort 的 signal：原样返回不压缩", async () => {
    const transform = createTransformContext(cfg());
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(user("x".repeat(500)));
      messages.push(assistant("y".repeat(500)));
    }
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await transform(messages, ctrl.signal);
    expect(out).toBe(messages); // 原样返回
  });
});

describe("B5 不变量守护 — validateAndRepairMessageSequence", () => {
  it("孤立 toolResult 被自动移除", () => {
    const messages = [user("u"), toolResult("orphan"), assistant("a")];
    const out = validateAndRepairMessageSequence(messages, "test");
    assertNoOrphanToolResult(out);
  });

  it("配对完整序列原样保留", () => {
    const messages = [user("u"), assistantCall("c1"), toolResult("c1"), assistant("a")];
    const out = validateAndRepairMessageSequence(messages, "test");
    expect(out.length).toBe(messages.length);
  });

  it("stripLeadingOrphanToolResults 去首部孤立", () => {
    const out = stripLeadingOrphanToolResults([toolResult("a"), user("u")]);
    expect(readMessageRole(out[0])).toBe("user");
  });

  it("stripAllOrphanToolResults 去全部孤立但保留配对", () => {
    const messages = [assistantCall("c1"), toolResult("c1"), toolResult("orphan")];
    const out = stripAllOrphanToolResults(messages);
    assertNoOrphanToolResult(out);
    expect(out.length).toBe(2);
  });
});

describe("B5 token 估算稳定性 — 极端输入不溢出/不 NaN", () => {
  it("超长字符串", () => {
    const t = estimateTokenCount([user("a".repeat(1_000_000))]);
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThan(0);
  });

  it("纯 emoji 与混合 CJK", () => {
    const t = estimateTokenCount([user("😀🎉你好abcこんにちは")]);
    expect(Number.isFinite(t)).toBe(true);
  });

  it("空内容与非常规结构不 NaN", () => {
    expect(estimateTokenCount([{ role: "user", content: "" } as AgentMessage])).toBe(0);
    expect(Number.isFinite(estimateTokenCount([{ role: "assistant" } as AgentMessage]))).toBe(true);
  });
});
