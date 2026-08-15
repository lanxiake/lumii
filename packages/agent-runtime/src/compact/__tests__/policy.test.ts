import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import {
  checkCompactionNeeded,
  computeMaxEstimatedHistoryTokens,
  resolveManualCompactKeepCount,
} from "../policy.js";
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

describe("resolveManualCompactKeepCount — 手动压缩始终可分割", () => {
  it("空会话无需保留", () => {
    expect(resolveManualCompactKeepCount(0, 6)).toBe(0);
  });

  it("1 条消息全部纳入摘要，不保留原文", () => {
    expect(resolveManualCompactKeepCount(1, 6)).toBe(0);
  });

  it("短于默认保留量时保留最近一半，保证有旧段可摘要", () => {
    expect(resolveManualCompactKeepCount(2, 6)).toBe(1);
    expect(resolveManualCompactKeepCount(4, 6)).toBe(2);
    expect(resolveManualCompactKeepCount(8, 6)).toBe(4);
    expect(resolveManualCompactKeepCount(12, 6)).toBe(6);
  });

  it("超过默认保留量时按请求轮数保留（一轮 2 条）", () => {
    expect(resolveManualCompactKeepCount(13, 6)).toBe(12);
    expect(resolveManualCompactKeepCount(20, 6)).toBe(12);
    expect(resolveManualCompactKeepCount(20, 3)).toBe(6);
  });

  it("keepRecentTurns=0 表示全部纳入摘要", () => {
    expect(resolveManualCompactKeepCount(20, 0)).toBe(0);
  });

  it("手动压缩时 compactCount 始终大于 0（只要有消息）", () => {
    for (const n of [1, 2, 3, 6, 11, 12, 13, 24]) {
      const keep = resolveManualCompactKeepCount(n, 6);
      expect(n - keep).toBeGreaterThan(0);
    }
  });
});
