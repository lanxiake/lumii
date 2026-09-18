/**
 * PalaceVectorIndex —— 宫殿向量索引（语义改写检索立项 T3）
 *
 * 用确定性假嵌入器（`createBigramHashEmbedder`）而非真模型：单测要的是
 * **索引行为**（写入/跳过/作用域/墓碑过滤），不是模型质量——后者由
 * `scripts/semantic-eval.mjs` 在真实语料上评测。混在一起会让单测既慢又不稳。
 */
import { describe, expect, it } from "vitest";
import { PalaceVectorIndex, buildPalaceVectorCorpus, PALACE_VECTOR_CORPUS_MAX_CHARS } from "../palace-vector.js";
import { PalaceRepo } from "../palace-repo.js";
import { createBigramHashEmbedder } from "../../wiki/wiki-vector.js";
import { createMigratedTestDb } from "../../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";

const U = "local-user";
const A = "assistant";

function setup() {
  const db = createMigratedTestDb();
  const repo = new PalaceRepo(db);
  const embedder = createBigramHashEmbedder(64);
  const index = new PalaceVectorIndex(db, embedder);
  return { db, repo, index, embedder };
}

function archive(repo: PalaceRepo, content: string, agent = A, room = "2026-09-18") {
  return repo.upsertDrawer({
    agentId: agent,
    userId: U,
    wing: `${agent}:${U}`,
    room,
    content,
    conversationId: "conv-1",
    segmentId: null,
  });
}

describe("buildPalaceVectorCorpus", () => {
  it("截断到与跑分台一致的 300 字（口径改了要重跑 T1，不能顺手调）", () => {
    const long = "甲".repeat(500);
    expect(buildPalaceVectorCorpus(long).length).toBe(PALACE_VECTOR_CORPUS_MAX_CHARS);
    expect(PALACE_VECTOR_CORPUS_MAX_CHARS).toBe(300);
  });

  it("短文本原样（trim 后）", () => {
    expect(buildPalaceVectorCorpus("  短内容  ")).toBe("短内容");
  });
});

describe("PalaceVectorIndex", () => {
  it("embedder 为 null 即整体禁用（禁止静默降级到别的检索）", async () => {
    const db: DatabaseAdapter = createMigratedTestDb();
    const off = new PalaceVectorIndex(db, null);
    expect(off.enabled).toBe(false);
    expect(await off.searchSimilar({ query: "任意", userId: U, limit: 5 })).toEqual([]);
    expect(off.stats(U)).toEqual({ indexed: 0, pending: 0 });
    // 禁用时写入是 no-op，不抛错
    await expect(
      off.upsertDrawer({ drawerId: "d1", agentId: A, userId: U, content: "x" }),
    ).resolves.toBeUndefined();
    db.close();
  });

  it("写入后可按语义相近度检索到", async () => {
    const { db, repo, index } = setup();
    const { drawerId } = archive(repo, "集群 goroutine 泄漏排查：pprof 显示阻塞在 channel 发送");
    archive(repo, "儿童绘本批量创作项目的样例文件路径");

    await index.upsertDrawer({
      drawerId,
      agentId: A,
      userId: U,
      content: "集群 goroutine 泄漏排查：pprof 显示阻塞在 channel 发送",
    });

    const hits = await index.searchSimilar({ query: "goroutine 泄漏", userId: U, limit: 5 });
    expect(hits[0]?.drawerId).toBe(drawerId);
    db.close();
  });

  it("语料未变且模型一致时跳过重算（嵌入是 30ms/条 量级的开销）", async () => {
    const { db, index, embedder } = setup();
    let calls = 0;
    const counting = {
      ...embedder,
      embed: async (t: string) => {
        calls += 1;
        return embedder.embed(t);
      },
    };
    const idx = new PalaceVectorIndex(db, counting);

    const d = { drawerId: "d1", agentId: A, userId: U, content: "同样的内容" };
    await idx.upsertDrawer(d);
    await idx.upsertDrawer(d);

    expect(calls).toBe(1);
    db.close();
  });

  it("内容变了要重算（content_hash 变了）", async () => {
    const { db, embedder } = setup();
    let calls = 0;
    const counting = {
      ...embedder,
      embed: async (t: string) => {
        calls += 1;
        return embedder.embed(t);
      },
    };
    const idx = new PalaceVectorIndex(db, counting);

    await idx.upsertDrawer({ drawerId: "d1", agentId: A, userId: U, content: "第一版" });
    await idx.upsertDrawer({ drawerId: "d1", agentId: A, userId: U, content: "第二版内容" });

    expect(calls).toBe(2);
    db.close();
  });

  it("作用域：传 agentId 只搜该 Agent，不传则跨 Agent", async () => {
    const { db, repo, index } = setup();
    const a = archive(repo, "甲助手的会话里提到了雪山路线", "agent-a");
    const b = archive(repo, "乙助手的会话里也提到了雪山路线", "agent-b");
    for (const [id, content, agent] of [
      [a.drawerId, "甲助手的会话里提到了雪山路线", "agent-a"],
      [b.drawerId, "乙助手的会话里也提到了雪山路线", "agent-b"],
    ] as const) {
      await index.upsertDrawer({ drawerId: id, agentId: agent, userId: U, content });
    }

    const all = await index.searchSimilar({ query: "雪山路线", userId: U, limit: 10 });
    expect(all.length).toBe(2);

    const scoped = await index.searchSimilar({
      query: "雪山路线",
      userId: U,
      agentId: "agent-a",
      limit: 10,
    });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.drawerId).toBe(a.drawerId);
    db.close();
  });

  it("已写墓碑的抽屉不进检索（与 FTS 侧同一纪律）", async () => {
    const { db, repo, index } = setup();
    const { drawerId } = archive(repo, "这段会被删除，关键词灯笼");

    await index.upsertDrawer({
      drawerId,
      agentId: A,
      userId: U,
      content: "这段会被删除，关键词灯笼",
    });
    expect(await index.searchSimilar({ query: "灯笼", userId: U, limit: 5 })).toHaveLength(1);

    repo.deleteById(drawerId);

    expect(await index.searchSimilar({ query: "灯笼", userId: U, limit: 5 })).toHaveLength(0);
    db.close();
  });

  it("stats 报出待补条数（首次启用时等于全量，需后台补齐）", async () => {
    const { db, repo, index } = setup();
    const a = archive(repo, "第一条内容");
    archive(repo, "第二条内容");

    expect(index.stats(U)).toEqual({ indexed: 0, pending: 2 });

    await index.upsertDrawer({
      drawerId: a.drawerId,
      agentId: A,
      userId: U,
      content: "第一条内容",
    });
    expect(index.stats(U)).toEqual({ indexed: 1, pending: 1 });
    db.close();
  });

  it("墓碑抽屉不计入 stats（否则待补会永远补不完）", async () => {
    const { db, repo, index } = setup();
    const { drawerId } = archive(repo, "会被删掉的");
    repo.deleteById(drawerId);

    expect(index.stats(U)).toEqual({ indexed: 0, pending: 0 });
    db.close();
  });

  it("clear 清空索引；关闭时是 no-op", async () => {
    const { db, repo, index } = setup();
    const { drawerId } = archive(repo, "会被清空索引的");
    await index.upsertDrawer({ drawerId, agentId: A, userId: U, content: "会被清空索引的" });
    expect(index.stats(U).indexed).toBe(1);

    index.clear();
    expect(index.stats(U).indexed).toBe(0);

    const off = new PalaceVectorIndex(db, null);
    expect(() => off.clear()).not.toThrow();
    db.close();
  });

  it("空查询返回空数组（调用方据此写降级原因）", async () => {
    const { db, repo, index } = setup();
    const { drawerId } = archive(repo, "内容");
    await index.upsertDrawer({ drawerId, agentId: A, userId: U, content: "内容" });

    expect(await index.searchSimilar({ query: "   ", userId: U, limit: 5 })).toEqual([]);
    db.close();
  });
});
