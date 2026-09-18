/**
 * V51 迁移验证：宫殿抽屉的向量索引（语义改写检索立项 T3）。
 *
 * 动因（`docs/plans/记忆系统/2026-09-18-语义改写检索开发计划.md`）：语义/同义改写查询
 * 在纯 bigram 下检索不到——实测「线程泄漏」→`goroutine 泄漏` 排 #17、
 * 「不在白名单」→`is blocked because of many connection errors` 排 #8。
 * T1 离线跑分确认 RRF 融合能把语义类 5/10 提到 8/10 且精确类零损失。
 *
 * 本用例守住：
 * 1. 表与索引建出来，字段与 `wiki_source_embeddings` 一一对应（两侧同构是有意为之）
 * 2. 幂等：DDL 重放不报错
 * 3. 存量数据不受影响（迁移只加表，不动既有行）
 * 4. `dims`/`embedding` 存得进取得出（BLOB 往返）
 */
import { describe, expect, it } from "vitest";
import { createPreV51TestDb, runMigration51 } from "../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "./local-database.js";
import { SCHEMA_VERSION } from "./schema.js";

function columns(db: DatabaseAdapter, table: string): string[] {
  return db
    .prepare<{ name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

function objectNames(db: DatabaseAdapter): string[] {
  return db
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = ?")
    .all("palace_drawer_embeddings")
    .map((r) => r.name);
}

describe("V51 迁移：宫殿向量索引", () => {
  it("SCHEMA_VERSION 已递增到 51", () => {
    expect(SCHEMA_VERSION).toBe(51);
  });

  it("建出 palace_drawer_embeddings，字段与 wiki_source_embeddings 同构", () => {
    const db = createPreV51TestDb();
    runMigration51(db);

    expect(objectNames(db)).toContain("palace_drawer_embeddings");
    // 与 wiki 侧一一对应（palace 用 drawer_id，wiki 用 source_id）
    expect(columns(db, "palace_drawer_embeddings")).toEqual([
      "drawer_id",
      "agent_id",
      "user_id",
      "model_id",
      "dims",
      "embedding",
      "content_hash",
      "updated_at",
    ]);
    db.close();
  });

  it("建出按作用域检索的索引", () => {
    const db = createPreV51TestDb();
    runMigration51(db);
    const idx = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_palace_emb_scope'",
      )
      .get();
    expect(idx?.name).toBe("idx_palace_emb_scope");
    db.close();
  });

  it("DDL 幂等：重放不报错", () => {
    const db = createPreV51TestDb();
    runMigration51(db);
    expect(() => runMigration51(db)).not.toThrow();
    db.close();
  });

  it("迁移只加表，不动既有宫殿数据", () => {
    const db = createPreV51TestDb();
    db.prepare(
      `INSERT INTO palace_drawers
         (drawer_id, agent_id, user_id, conversation_id, segment_id, wing, room, content, char_count, created_at, deleted_at)
       VALUES ('d1', 'a1', 'u1', NULL, NULL, 'w', 'r', '既有原文', 4, '2026-09-01T00:00:00.000Z', NULL)`,
    ).run();

    runMigration51(db);

    const row = db
      .prepare<{ drawer_id: string; content: string }>(
        "SELECT drawer_id, content FROM palace_drawers WHERE drawer_id = 'd1'",
      )
      .get();
    expect(row?.content).toBe("既有原文");
    db.close();
  });

  it("BLOB 向量与 dims 往返无损", () => {
    const db = createPreV51TestDb();
    runMigration51(db);

    const vec = new Float32Array([0.1, -0.25, 0.5, 0.75]);
    const buf = Buffer.from(vec.buffer);
    db.prepare(
      `INSERT INTO palace_drawer_embeddings
         (drawer_id, agent_id, user_id, model_id, dims, embedding, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("d1", "a1", "u1", "e5-small", vec.length, buf, "hash", "2026-09-18T00:00:00.000Z");

    const back = db
      .prepare<{ dims: number; embedding: Buffer }>(
        "SELECT dims, embedding FROM palace_drawer_embeddings WHERE drawer_id = 'd1'",
      )
      .get();
    expect(back?.dims).toBe(4);
    const restored = new Float32Array(
      back!.embedding.buffer,
      back!.embedding.byteOffset,
      back!.embedding.byteLength / 4,
    );
    expect([...restored]).toEqual([...vec]);
    db.close();
  });
});
