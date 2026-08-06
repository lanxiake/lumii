import { describe, expect, it } from "vitest";
import { providerPromptTokens } from "../token-estimate.js";

describe("providerPromptTokens", () => {
  it("无缓存时等于 inputTokens", () => {
    expect(providerPromptTokens({ inputTokens: 12000 })).toBe(12000);
  });

  /**
   * 回归用例：这是「上下文掉到 152」的成因。
   * 缓存命中后 10K+ 的系统提示词记在 cacheRead，inputTokens 只剩本轮增量。
   */
  it("缓存命中时把 cacheRead 一并计入", () => {
    expect(providerPromptTokens({ inputTokens: 152, cacheRead: 11800 })).toBe(11952);
  });

  it("首轮写入缓存时把 cacheWrite 一并计入", () => {
    expect(providerPromptTokens({ inputTokens: 200, cacheWrite: 11800 })).toBe(12000);
  });

  it("三者同时存在时全部相加", () => {
    expect(providerPromptTokens({ inputTokens: 100, cacheRead: 9000, cacheWrite: 500 })).toBe(9600);
  });

  it("字段缺失按 0 处理，不产出 NaN", () => {
    expect(providerPromptTokens({})).toBe(0);
    expect(providerPromptTokens({ cacheRead: 5 })).toBe(5);
  });
});
