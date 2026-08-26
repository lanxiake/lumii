/**
 * 向量检索与 RRF 单测
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import {
  WikiVectorIndex,
  createBigramHashEmbedder,
  cosineSimilarity,
  mergeHybridRanks,
  reciprocalRankFusion,
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

describe("WikiVectorIndex", () => {
  it("写入向量后可召回相近查询；混合排序可用", async () => {
    const db = createMigratedTestDb();
    const repo = new WikiRepo(db);
    const page = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/wx",
      title: "微信语音",
      contentMd: "微信语音转文字与识别方案",
      editor: "user",
    });
    const other = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/k8s",
      title: "K8s 部署",
      contentMd: "Kubernetes 集群部署手册",
      editor: "user",
    });

    const index = new WikiVectorIndex(db, createBigramHashEmbedder());
    await index.upsertPage(page);
    await index.upsertPage(other);

    const hits = await index.searchSimilar("ag", "u", "微信语音识别", 5);
    expect(hits[0]?.pageId).toBe(page.id);

    const merged = mergeHybridRanks({
      ftsIds: [other.id, page.id],
      vectorIds: hits.map((h) => h.pageId),
      pageById: new Map([
        [page.id, page],
        [other.id, other],
      ]),
    });
    expect(merged.mode).toBe("hybrid");
    expect(merged.ids.length).toBeGreaterThan(0);
    db.close();
  });
});
