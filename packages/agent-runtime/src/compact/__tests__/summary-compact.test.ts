import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import { runSummaryStage } from "../strategies/summary-compact.js";
import type { CompactConfig } from "../types.js";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return { role: "assistant", content: text } as AgentMessage;
}

/** 构造多轮旧消息（供 PTL 丢弃测试） */
function buildOldMessages(rounds: number): AgentMessage[] {
  const msgs: AgentMessage[] = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push(user(`u${i}`));
    msgs.push(assistant(`a${i} ${"x".repeat(100)}`));
  }
  return msgs;
}

function baseConfig(overrides: Partial<CompactConfig> = {}): CompactConfig {
  return {
    contextWindow: 10_000,
    triggerRatio: 0.9,
    keepRecentTurns: 4,
    outputReserveTokens: 500,
    summaryReserveTokens: 500,
    ...overrides,
  };
}

class PtlError extends Error {
  constructor() {
    super("prompt is too long: 123000 tokens > 100000 maximum");
  }
}

describe("runSummaryStage — PTL 重试逃生口", () => {
  it("首次 PTL、第二次成功：重试 1 次后成功，ptlRetries=1", async () => {
    let calls = 0;
    const config = baseConfig({
      generateSummary: async () => {
        calls++;
        if (calls === 1) throw new PtlError();
        return "<summary>ok</summary>";
      },
    });
    const result = await runSummaryStage(buildOldMessages(10), config);
    expect(result.summaryMessage).not.toBeNull();
    expect(result.ptlRetries).toBe(1);
    expect(result.failed).toBe(false);
    expect(calls).toBe(2);
  });

  it("连续 PTL 耗尽重试：降级占位，failed=true，ptlRetries=maxPtlRetries", async () => {
    let calls = 0;
    const config = baseConfig({
      maxPtlRetries: 3,
      generateSummary: async () => {
        calls++;
        throw new PtlError();
      },
    });
    const result = await runSummaryStage(buildOldMessages(20), config);
    expect(result.summaryMessage).toBeNull();
    expect(result.failed).toBe(true);
    expect(result.ptlRetries).toBe(3);
    // 初次 + 3 次重试 = 4 次调用
    expect(calls).toBe(4);
  });

  it("非 PTL 错误：不重试，直接降级 failed=true，ptlRetries=0", async () => {
    let calls = 0;
    const config = baseConfig({
      generateSummary: async () => {
        calls++;
        throw new Error("network timeout");
      },
    });
    const result = await runSummaryStage(buildOldMessages(10), config);
    expect(result.summaryMessage).toBeNull();
    expect(result.failed).toBe(true);
    expect(result.ptlRetries).toBe(0);
    expect(calls).toBe(1);
  });

  it("空返回：不重试，failed=true（计断路器）", async () => {
    const config = baseConfig({
      generateSummary: async () => "   ",
    });
    const result = await runSummaryStage(buildOldMessages(10), config);
    expect(result.summaryMessage).toBeNull();
    expect(result.failed).toBe(true);
    expect(result.ptlRetries).toBe(0);
  });

  it("未注入 generateSummary：直接返回 null、不计失败", async () => {
    const result = await runSummaryStage(buildOldMessages(10), baseConfig());
    expect(result.summaryMessage).toBeNull();
    expect(result.failed).toBe(false);
  });

  it("自定义 isContextLengthError 注入：据其判定是否 PTL 重试", async () => {
    let calls = 0;
    const config = baseConfig({
      isContextLengthError: (err) => err instanceof Error && err.message.includes("CUSTOM_PTL"),
      generateSummary: async () => {
        calls++;
        if (calls === 1) throw new Error("CUSTOM_PTL exceeded");
        return "<summary>recovered</summary>";
      },
    });
    const result = await runSummaryStage(buildOldMessages(10), config);
    expect(result.summaryMessage).not.toBeNull();
    expect(result.ptlRetries).toBe(1);
  });

  it("成功摘要包含 historyRecallHint 回查指针", async () => {
    const config = baseConfig({
      historyRecallHint: true,
      generateSummary: async () => "<summary>done</summary>",
    });
    const result = await runSummaryStage(buildOldMessages(10), config);
    const content = (result.summaryMessage as { content?: string }).content ?? "";
    expect(content).toContain("memory_read");
  });

  it("成功摘要含 sessionKey 时会话过滤提示透传", async () => {
    const config = baseConfig({
      historyRecallHint: true,
      sessionKey: "sess-test-001",
      generateSummary: async () => "<summary>done</summary>",
    });
    const result = await runSummaryStage(buildOldMessages(10), config);
    const content = (result.summaryMessage as { content?: string }).content ?? "";
    expect(content).toContain("sessionKey=sess-test-001");
  });
});
