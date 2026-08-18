import { describe, it, expect } from "vitest";
import { checkCompactionNeeded } from "./policy.js";
import type { CompactConfig } from "./types.js";
import type { AgentMessage } from "../types.js";

describe("checkCompactionNeeded - Phase 1: thresholdTokensCap + 小窗口地板", () => {
  const createTestMessage = (content: string): AgentMessage => ({
    id: Math.random().toString(),
    role: "user",
    content,
    createdAt: Date.now(),
  });

  it("配错 1M 95% 被 Cap 拦下", () => {
    const config: CompactConfig = {
      contextWindow: 1_000_000,
      triggerRatio: 0.95,
      thresholdTokensCap: 200_000,
    };
    // 构造 250K tokens（假设 1 char ≈ 0.25 token，需 1M 字符）
    const messages = [createTestMessage("x".repeat(1_000_000))];
    const result = checkCompactionNeeded(messages, config);
    // 预期 threshold = min(1M*0.95=950K, 200K) = 200K
    expect(result.threshold).toBe(200_000);
    expect(result.totalTokens).toBeGreaterThan(200_000);
    expect(result.needsCompaction).toBe(true);
  });

  it("ratio 比 cap 小，取 ratio", () => {
    const config: CompactConfig = {
      contextWindow: 200_000,
      triggerRatio: 0.78,
      thresholdTokensCap: 200_000,
    };
    const messages = [createTestMessage("x".repeat(640_000))]; // ~160K tokens
    const result = checkCompactionNeeded(messages, config);
    // 预期 threshold = min(200K*0.78=156K, 200K) = 156K
    expect(result.threshold).toBe(156_000);
  });

  it("小窗口 128K 强制 75% 地板", () => {
    const config: CompactConfig = {
      contextWindow: 128_000,
      triggerRatio: 0.70, // 故意低
      thresholdTokensCap: 200_000,
    };
    const messages = [createTestMessage("x".repeat(384_000))]; // ~96K tokens
    const result = checkCompactionNeeded(messages, config);
    // 预期 threshold = max(0.70, 0.75) * 128K = 96K
    expect(result.threshold).toBe(96_000);
    expect(result.totalTokens).toBeGreaterThan(96_000);
    expect(result.needsCompaction).toBe(true);
  });

  it("小窗口 128K 用户配 0.80 不被拉低", () => {
    const config: CompactConfig = {
      contextWindow: 128_000,
      triggerRatio: 0.80,
      thresholdTokensCap: 200_000,
    };
    const messages = [createTestMessage("x".repeat(410_000))]; // ~102.5K tokens
    const result = checkCompactionNeeded(messages, config);
    // 预期 threshold = max(0.80, 0.75) * 128K = 102.4K
    expect(result.threshold).toBe(102_400);
  });

  it("cap=null 走纯 ratio", () => {
    const config: CompactConfig = {
      contextWindow: 1_000_000,
      triggerRatio: 0.78,
      thresholdTokensCap: undefined,
    };
    const messages = [createTestMessage("x".repeat(3_120_000))]; // ~780K tokens
    const result = checkCompactionNeeded(messages, config);
    // 预期 threshold = 1M * 0.78 = 780K（无 cap 限制）
    expect(result.threshold).toBe(780_000);
    expect(result.totalTokens).toBeGreaterThan(780_000);
    expect(result.needsCompaction).toBe(true);
  });
});

