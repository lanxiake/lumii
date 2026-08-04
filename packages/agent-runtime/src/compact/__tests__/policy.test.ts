import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import { checkCompactionNeeded, computeMaxEstimatedHistoryTokens } from "../policy.js";
import type { CompactConfig } from "../types.js";

function cfg(overrides: Partial<CompactConfig> = {}): CompactConfig {
  return {
    contextWindow: 100_000,
    triggerRatio: 0.78,
    keepRecentTurns: 6,
    outputReserveTokens: 16_384,
    summaryReserveTokens: 8_192,
    ...overrides,
  };
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

describe("policy — 阈值计算", () => {
  it("触发阈值 = contextWindow × triggerRatio，与预留无关", () => {
    const r = checkCompactionNeeded([user("hi")], cfg());
    expect(r.threshold).toBe(Math.floor(100_000 * 0.78));
  });

  it("computeMaxEstimatedHistoryTokens 扣预留后 ×0.75，最低 8000", () => {
    const max = computeMaxEstimatedHistoryTokens(cfg());
    const expected = Math.floor((100_000 - 16_384 - 8_192) * 0.75);
    expect(max).toBe(expected);
    // 极小窗口兜底 8000
    const tiny = computeMaxEstimatedHistoryTokens(
      cfg({ contextWindow: 1000, outputReserveTokens: 500, summaryReserveTokens: 500 }),
    );
    expect(tiny).toBe(8000);
  });

  it("needsCompaction 在超阈值时为 true", () => {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 100; i++) msgs.push(user("x".repeat(2000)));
    const r = checkCompactionNeeded(msgs, cfg({ contextWindow: 10_000, triggerRatio: 0.5 }));
    expect(r.needsCompaction).toBe(true);
  });
});
