/**
 * 资料层向量索引与混合排序
 */

import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import {
  WikiSourceVectorIndex,
  mergeSourceHybridRanks,
} from "./wiki-source-vector.js";
import { createBigramHashEmbedder } from "./wiki-vector.js";

function mkSource(repo: WikiRepo, title: string, text: string) {
  const s = repo.createSource({ agentId: "ag", userId: "u", title, extractedText: text });
  repo.updateSourceTopic("ag", "u", s.id, "学习资料", "调研搜集材料");
  return s;
}

describe("WikiSourceVectorIndex", () => {
  it("V24 建出 wiki_source_embeddings 表", () => {
    const db = createMigratedTestDb();
    const name = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'wiki_source_embeddings'")
      .get()?.name;
    expect(name).toBe("wiki_source_embeddings");
  });

  it("写入向量后可召回相近查询", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = mkSource(repo, "微信语音", "微信语音转文字与识别方案");
    const idx = new WikiSourceVectorIndex(repo.database, createBigramHashEmbedder(64));

    await idx.upsertSource(s);
    const hits = await idx.searchSimilar("ag", "u", "微信语音识别", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.sourceId).toBe(s.id);
  });

  it("正文未变时不重复 embed", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = mkSource(repo, "调研", "正文内容");
    const emb = createBigramHashEmbedder(64);
    const spy = { calls: 0, ...emb, embed: async (t: string) => { spy.calls += 1; return emb.embed(t) } };
    const idx = new WikiSourceVectorIndex(repo.database, spy);

    await idx.upsertSource(s);
    await idx.upsertSource(s);
    expect(spy.calls).toBe(1);
  });

  it("embedder 为 null 时禁用，searchSimilar 返回空", async () => {
    const idx = new WikiSourceVectorIndex(createMigratedTestDb(), null);
    expect(idx.enabled).toBe(false);
    expect(await idx.searchSimilar("ag", "u", "x", 5)).toEqual([]);
  });

  it("rebuild 返回写入条数", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    mkSource(repo, "a", "甲");
    mkSource(repo, "b", "乙");
    const idx = new WikiSourceVectorIndex(repo.database, createBigramHashEmbedder(64));
    expect(await idx.rebuild(repo.listSources("ag", "u"))).toBe(2);
  });
});

describe("mergeSourceHybridRanks", () => {
  it("只有 FTS 命中时 mode 为 fts", () => {
    expect(
      mergeSourceHybridRanks({ ftsIds: ["a"], vectorIds: [], sourceById: new Map() }).mode,
    ).toBe("fts");
  });

  it("两路都有命中时 mode 为 hybrid 且保留顺序", () => {
    const r = mergeSourceHybridRanks({
      ftsIds: ["a", "b"],
      vectorIds: ["b", "a"],
      sourceById: new Map(),
    });
    expect(r.mode).toBe("hybrid");
    expect(r.ids).toHaveLength(2);
  });

  it("只有向量命中时 mode 为 vector", () => {
    expect(
      mergeSourceHybridRanks({ ftsIds: [], vectorIds: ["a"], sourceById: new Map() }).mode,
    ).toBe("vector");
  });
});
