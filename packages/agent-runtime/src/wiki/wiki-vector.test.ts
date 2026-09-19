/**
 * 向量检索通用工具单测（凸组合 / 余弦）—— 页面向量索引已随 P3 删除，
 * 具体的资料层向量索引测试见 wiki-source-vector.test.ts。
 *
 * `reciprocalRankFusion` 仍在别处（wiki 源检索）使用，保留其用例。
 */
import { describe, expect, it } from "vitest";
import {
  createBigramHashEmbedder,
  cosineSimilarity,
  reciprocalRankFusion,
  convexScoreFusion,
} from "./wiki-vector.js";

describe("reciprocalRankFusion / cosine", () => {
  it("RRF 合并两路排名", () => {
    const scores = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "a", "d"],
    ]);
    expect(scores.get("b")!).toBeGreaterThan(scores.get("c")!);
  });

  it("相同向量余弦为 1", async () => {
    const emb = createBigramHashEmbedder(64);
    const v = await emb.embed("微信语音识别");
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });
});

describe("convexScoreFusion", () => {
  it("BM25 是负值、越小越相关，归一化时要翻转", () => {
    const fused = convexScoreFusion(
      [
        { id: "a", score: -30 },
        { id: "b", score: -5 },
      ],
      [],
    );
    expect(fused.get("a")!).toBeGreaterThan(fused.get("b")!);
    expect(fused.get("a")!).toBeCloseTo(0.6, 5);
    expect(fused.get("b")!).toBeCloseTo(0, 5);
  });

  it("余弦越大越相关，不翻转", () => {
    const fused = convexScoreFusion(
      [],
      [
        { id: "a", score: 0.93 },
        { id: "b", score: 0.86 },
      ],
      0.4,
    );
    expect(fused.get("a")!).toBeCloseTo(0.6, 5);
    expect(fused.get("b")!).toBeCloseTo(0, 5);
  });

  it("两路都靠前的条目胜过只有一路靠前的条目", () => {
    // 真实形状：金标准条目在两路都靠前；干扰项只在其中一路靠前。
    // 这正是要取代 RRF 的动机——RRF 下「稀疏 #1 + 稠密缺席」会被
    // 「稀疏靠后 + 稠密 #1」挤下去。
    const fused = convexScoreFusion(
      [
        { id: "gold", score: -25 },
        { id: "noiseB", score: -20 },
        { id: "noiseC", score: -15 },
        { id: "noiseD", score: -12 },
        { id: "noiseE", score: -10 },
      ],
      [
        { id: "noiseS", score: 0.95 },
        { id: "gold", score: 0.9 },
        { id: "noiseT", score: 0.85 },
        { id: "noiseU", score: 0.8 },
        { id: "noiseV", score: 0.75 },
      ],
    );
    const gold = fused.get("gold")!;
    // 只在稀疏路靠前的
    expect(gold).toBeGreaterThan(fused.get("noiseB")!);
    // 只在稠密路第一的
    expect(gold).toBeGreaterThan(fused.get("noiseS")!);
    // 缺席那一路按 0 计入，不是被排除
    expect(fused.get("noiseS")!).toBeGreaterThan(0);
    expect(fused.get("noiseB")!).toBeGreaterThan(0);
  });

  it("单候选时 span=0 记 0.5，而不是记满或记零", () => {
    const fused = convexScoreFusion([{ id: "only", score: -12 }], [], 0.6);
    expect(fused.get("only")!).toBeCloseTo(0.3, 5); // 0.6 × 0.5
  });

  it("两路都为空返回空 Map", () => {
    expect(convexScoreFusion([], []).size).toBe(0);
  });

  it("分数全等时整路记 0.5（该路无信息，不打压也不抬举）", () => {
    const fused = convexScoreFusion(
      [
        { id: "a", score: -10 },
        { id: "b", score: -10 },
      ],
      [],
      0.6,
    );
    expect(fused.get("a")!).toBeCloseTo(0.3, 5);
    expect(fused.get("b")!).toBeCloseTo(0.3, 5);
  });

  it("只在一路出现的 id 按另一路缺席（0）参与，仍在结果里", () => {
    const fused = convexScoreFusion([{ id: "s", score: -20 }], [{ id: "d", score: 0.9 }]);
    expect(fused.has("s")).toBe(true);
    expect(fused.has("d")).toBe(true);
  });
});
