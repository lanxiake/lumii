/**
 * 向量检索通用工具单测（RRF / 余弦）—— 页面向量索引已随 P3 删除，
 * 具体的资料层向量索引测试见 wiki-source-vector.test.ts。
 */
import { describe, expect, it } from "vitest";
import { createBigramHashEmbedder, cosineSimilarity, reciprocalRankFusion } from "./wiki-vector.js";

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
