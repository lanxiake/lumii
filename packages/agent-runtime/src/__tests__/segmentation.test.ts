/**
 * segmentation 纯函数单测（S1）
 *
 * 重点：先验证中文 bigram 分词质量（设计 S1 的质量门槛），再验证 overlap 与边界判定。
 */

import { describe, it, expect } from "vitest";
import {
  tokenizeBigram,
  overlapCoefficient,
  shouldCloseSegment,
  type SegmentBoundaryState,
} from "../memory/segmentation.js";

describe("tokenizeBigram（中文分词质量）", () => {
  it("中文串生成 bigram", () => {
    const t = tokenizeBigram("爬山");
    expect(t).toEqual(new Set(["爬山"]));
  });
  it("多字中文滑窗 bigram", () => {
    expect(tokenizeBigram("喜欢爬山")).toEqual(new Set(["喜欢", "欢爬", "爬山"]));
  });
  it("单字中文取单字", () => {
    expect(tokenizeBigram("好")).toEqual(new Set(["好"]));
  });
  it("中英混合：英文整词 + 中文 bigram", () => {
    const t = tokenizeBigram("我用 Python 写代码");
    expect(t.has("python")).toBe(true);
    expect(t.has("写代")).toBe(true);
    expect(t.has("代码")).toBe(true);
  });
  it("标点/空格/emoji 被忽略", () => {
    const t = tokenizeBigram("你好，世界！😀 hello");
    expect(t.has("你好")).toBe(true);
    expect(t.has("好世") /* 跨标点不连 */).toBe(false);
    expect(t.has("世界")).toBe(true);
    expect(t.has("hello")).toBe(true);
  });
  it("英文大小写归一", () => {
    expect(tokenizeBigram("Hello WORLD")).toEqual(new Set(["hello", "world"]));
  });
  it("空串返回空集", () => {
    expect(tokenizeBigram("").size).toBe(0);
  });
});

describe("overlapCoefficient", () => {
  it("完全相同 = 1", () => {
    const a = tokenizeBigram("喜欢爬山");
    expect(overlapCoefficient(a, a)).toBe(1);
  });
  it("交集/min：子集包含 = 1", () => {
    const a = tokenizeBigram("爬山"); // {爬山}
    const b = tokenizeBigram("喜欢爬山"); // {喜欢,欢爬,爬山}
    expect(overlapCoefficient(a, b)).toBe(1); // 1/min(1,3)=1
  });
  it("无交集 = 0", () => {
    expect(overlapCoefficient(tokenizeBigram("旅行计划"), tokenizeBigram("写代码"))).toBe(0);
  });
  it("空集 = 0", () => {
    expect(overlapCoefficient(new Set(), tokenizeBigram("x"))).toBe(0);
  });
});

describe("shouldCloseSegment", () => {
  const base: SegmentBoundaryState = {
    lastTurnTs: 1_000_000,
    topicTokens: tokenizeBigram("我们讨论旅行计划去日本玩"),
    turnCount: 3,
    charCount: 200,
  };

  it("时间间隔超阈值 → time_gap", () => {
    const r = shouldCloseSegment(base, { ts: base.lastTurnTs + 21 * 60_000, text: "继续" });
    expect(r).toBe("time_gap");
  });

  it("显式线索 → explicit_cue", () => {
    const r = shouldCloseSegment(base, { ts: base.lastTurnTs + 1000, text: "换个话题，帮我写代码" });
    expect(r).toBe("explicit_cue");
  });

  it("容量超轮数 → capacity", () => {
    const r = shouldCloseSegment(
      { ...base, turnCount: 12 },
      { ts: base.lastTurnTs + 1000, text: "还是聊旅行" },
    );
    expect(r).toBe("capacity");
  });

  it("主题切换（overlap 低）→ topic_shift", () => {
    const r = shouldCloseSegment(base, {
      ts: base.lastTurnTs + 1000,
      text: "帮我调试这段报错的代码",
    });
    expect(r).toBe("topic_shift");
  });

  it("同主题继续 → null（并入当前段）", () => {
    const r = shouldCloseSegment(base, {
      ts: base.lastTurnTs + 1000,
      text: "旅行计划里日本的行程怎么安排",
    });
    expect(r).toBeNull();
  });

  it("短句（token 不足）不触发主题切换", () => {
    const r = shouldCloseSegment(base, { ts: base.lastTurnTs + 1000, text: "嗯好" });
    expect(r).toBeNull();
  });

  it("阈值可配：放宽容量上限", () => {
    const r = shouldCloseSegment(
      { ...base, turnCount: 12 },
      { ts: base.lastTurnTs + 1000, text: "还是聊旅行计划日本" },
      { maxTurns: 20 },
    );
    expect(r).toBeNull();
  });
});
