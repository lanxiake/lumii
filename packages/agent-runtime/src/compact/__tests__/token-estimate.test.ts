import { describe, expect, it } from "vitest";

import { estimateTextTokenCount, ceilTokenEstimate } from "../token-estimate.js";

describe("estimateTextTokenCount", () => {
  it("英文字符按 0.3 token/字符估算", () => {
    expect(estimateTextTokenCount("abcd")).toBeCloseTo(1.2, 5);
  });

  it("中文字符按 0.6 token/字符估算", () => {
    expect(estimateTextTokenCount("你好")).toBeCloseTo(1.2, 5);
  });

  it("中英混排分别加权", () => {
    expect(estimateTextTokenCount("Hi你好")).toBeCloseTo(0.3 * 2 + 0.6 * 2, 5);
  });
});

describe("ceilTokenEstimate", () => {
  it("向上取整", () => {
    expect(ceilTokenEstimate(1.1)).toBe(2);
    expect(ceilTokenEstimate(3)).toBe(3);
  });
});
