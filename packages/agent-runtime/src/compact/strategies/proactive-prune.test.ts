import { describe, it, expect } from "vitest";
import { proactivePrune } from "./micro-compact.js";
import type { AgentMessage } from "../../types.js";

describe("proactivePrune - Phase 1: 总包装 + 7 道 Gate", () => {
  const createToolResult = (content: string, toolName = "bash"): AgentMessage => ({
    id: Math.random().toString(),
    role: "toolResult",
    toolName,
    content,
    createdAt: Date.now(),
  });

  const createAssistantWithToolCall = (argsContent: string): AgentMessage => ({
    id: Math.random().toString(),
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call1",
        function: {
          name: "write_file",
          arguments: JSON.stringify({ content: argsContent }),
        },
      },
    ],
    createdAt: Date.now(),
  });

  it("三阶段实际提交：Dedup + Summarize + Truncate → reclaim > 4096", () => {
    // 构造：3 条相同 bash（各 3000 字符，去重回收 6000 字符 ≈ 1500 tokens）
    // + 1 条 50KB write_file arguments（截断回收 ≈ 10K tokens）
    const content = "x".repeat(3000);
    const messages: AgentMessage[] = [
      createToolResult(content),
      createToolResult(content),
      createToolResult(content),
      createToolResult("different"),
      createAssistantWithToolCall("y".repeat(50_000)),
      ...Array.from({ length: 20 }, () => createToolResult("recent")), // tail 保护
    ];
    const result = proactivePrune(messages, {
      contextWindow: 200_000,
      proactivePruneRatio: 0.48,
      protectLastN: 20,
      keepRecentToolResults: 20,
    });
    expect(result.changed).toBe(true);
    expect(result.reclaimedTokens).toBeGreaterThan(4096);
    expect(result.nextRearmTokens).toBeGreaterThan(0);
    expect(result.passStats.dedupedCount).toBe(2); // 3 条相同，2 条去重
  });

  it("Reclaim Gate 拒绝：回收 < 4096 → 返回原 input 引用", () => {
    const messages: AgentMessage[] = [
      createToolResult("x".repeat(1000)), // 只能回收 1000 字符 ≈ 250 tokens
      createToolResult("y".repeat(1000)),
    ];
    const result = proactivePrune(messages, {
      contextWindow: 200_000,
      proactivePruneMinReclaimTokens: 4096,
    });
    // 关键断言：返回的是原数组引用（不是新数组）
    expect(result.messages).toBe(messages);
    expect(result.changed).toBe(false);
    expect(result.nextRearmTokens).toBe(null);
  });

  it("Rearm 防抖动：第一次触发后设置跑道，第二次未到跑道 → 直接拒绝", () => {
    const messages: AgentMessage[] = [
      ...Array.from({ length: 30 }, () => createToolResult("x".repeat(3000))),
    ];
    // 第一次：before=30*3000*0.25≈22.5K tokens，假设回收 8K → after=14.5K
    const result1 = proactivePrune(messages, {
      contextWindow: 200_000,
      proactivePruneRatio: 0.48, // trigger=96K
      proactivePruneMinReclaimTokens: 4096,
      protectLastN: 20,
    });
    expect(result1.changed).toBe(true);
    const rearm1 = result1.nextRearmTokens!;
    expect(rearm1).toBeGreaterThan(result1.reclaimedTokens);

    // 第二次：构造 before < rearm1（比如涨到 rearm1 - 1000）
    const messages2 = messages.slice(0, 20); // 少一些，模拟 before 未到跑道
    const result2 = proactivePrune(messages2, {
      contextWindow: 200_000,
      currentRearmTokens: rearm1,
    });
    // Gate 4 挡下，连扫描都不做
    expect(result2.messages).toBe(messages2);
    expect(result2.changed).toBe(false);
  });

  it("Rearm 后再涨到阈值可触发", () => {
    // 先触发一次，拿到 rearm
    const messages1: AgentMessage[] = [
      ...Array.from({ length: 30 }, () => createToolResult("x".repeat(3000))),
    ];
    const result1 = proactivePrune(messages1, {
      contextWindow: 200_000,
      proactivePruneRatio: 0.48,
    });
    const rearm1 = result1.nextRearmTokens!;

    // 构造 before > rearm1（涨满跑道）
    const messages2: AgentMessage[] = [
      ...Array.from({ length: 50 }, () => createToolResult("z".repeat(3000))),
    ];
    const result2 = proactivePrune(messages2, {
      contextWindow: 200_000,
      currentRearmTokens: rearm1,
    });
    // 可以触发
    expect(result2.changed).toBe(true);
  });

  it("Dedup 全范围（含 tail）无损", () => {
    const content = "x".repeat(3000);
    const messages: AgentMessage[] = [
      createToolResult(content),
      createToolResult(content),
      ...Array.from({ length: 20 }, () => createToolResult(content)), // tail 内也有重复
    ];
    const result = proactivePrune(messages, {
      contextWindow: 200_000,
      protectLastN: 20,
    });
    // tail 内的也应该去重（因为 dedup 无损，全范围可做）
    expect(result.passStats.dedupedCount).toBeGreaterThan(20); // 22 条重复，21 条去重
  });
});
