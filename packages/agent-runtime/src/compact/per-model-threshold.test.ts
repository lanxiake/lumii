import { describe, it, expect } from "vitest";
import { resolveModelThreshold } from "./policy.js";

describe("resolveModelThreshold - Phase 2: Per-Model 阈值最长子串匹配", () => {
  it("更长 key 优先命中", () => {
    const result = resolveModelThreshold(
      "claude-sonnet-4-20250514",
      { "claude": 0.50, "claude-sonnet": 0.35 },
      0.78,
    );
    expect(result).toBe(0.35); // 更长的 "claude-sonnet" 优先
  });

  it("不匹配回退 default", () => {
    const result = resolveModelThreshold(
      "gpt-5-6-1M",
      { "claude": 0.50 },
      0.78,
    );
    expect(result).toBe(0.78); // 没有匹配，回退默认
  });

  it("key 完全相等匹配", () => {
    const result = resolveModelThreshold(
      "qwen2.5-7b",
      { "qwen2.5-7b": 0.70 },
      0.78,
    );
    expect(result).toBe(0.70);
  });

  it("空 dict / 空 name 回退", () => {
    expect(resolveModelThreshold("", {}, 0.78)).toBe(0.78);
    expect(resolveModelThreshold("model", {}, 0.78)).toBe(0.78);
  });

  it("null thresholds 回退", () => {
    const result = resolveModelThreshold("qwen2.5", undefined, 0.78);
    expect(result).toBe(0.78);
  });
});
