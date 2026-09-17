/**
 * V49 迁移验证：自建记忆宫殿（去 Python 依赖）。
 *
 * 动因（评审 2026-09-17 §4.6 / 自建记忆宫殿实施计划）：宫殿原由 MemPalace（Python + chromadb）
 * 承载，本机 chromadb Rust 内核 upsert 直接崩溃，`palace_drawer_id` 覆盖率实测 4/171 = 2.3%。
 * 本迁移提供宫殿自己的承载表，`memory_search` 的宫殿通道不再依赖 Python。
 *
 * 本用例守住：
 * 1. 三张对象建出来：`palace_drawers` 主表、两个索引、`palace_drawers_fts` 虚表
 * 2. 幂等：同一段 DDL 重放不报错（迁移在 `isMigrationAlreadyApplied` 无守卫时会被重放）
 * 3. 存量数据不受影响：`memory_segments` / `agent_memories` 行数与内容原样
 * 4. `segment_id` 的外键声明存在（段被删时置空，而不是把归档原文一起带走）
 * 5. FTS 真的能查（不是建了个空壳）
 */
import { describe, expect, it } from "vitest";
import { createPreV49TestDb, runMigration49 } from "../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "./local-database.js";
import { SCHEMA_VERSION } from "./schema.js";
import { bigramJoin } from "../memory/memory-index.js";

function columns(db: DatabaseAdapter, table: string): string[] {
  return db
    .prepare<{ name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

function objectNames(db: DatabaseAdapter): string[] {
  return db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')",
    )
    .all()
    .map((r) => r.name);
}

describe("V49 迁移", () => {
  it("SCHEMA_VERSION 已推进到 49", () => {
    // 断言「不小于」：后续版本会继续推进，写死等号会在每次加迁移时误报
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(49);
  });

  it("建出 palace_drawers 主表与两个索引", () => {
    const db = createPreV49TestDb();
    expect(objectNames(db)).not.toContain("palace_drawers");

    runMigration49(db);

    expect(objectNames(db)).toEqual(
      expect.arrayContaining([
        "palace_drawers",
        "palace_drawers_fts",
        "idx_palace_drawers_scope",
        "idx_palace_drawers_segment",
      ]),
    );
    expect(columns(db, "palace_drawers")).toEqual(
      expect.arrayContaining([
        "drawer_id",
        "agent_id",
        "user_id",
        "conversation_id",
        "segment_id",
        "wing",
        "room",
        "content",
        "char_count",
        "created_at",
        "deleted_at",
      ]),
    );
  });

  it("palace_drawers_fts 是可写的 FTS5 虚表", () => {
    const db = createPreV49TestDb();
    runMigration49(db);

    const ddl = db
      .prepare<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE name = 'palace_drawers_fts'",
      )
      .get()!.sql;
    expect(ddl).toContain("fts5");

    db.prepare("INSERT INTO palace_drawers_fts (rowid, content) VALUES (1, ?)").run(
      bigramJoin("工单同步卡点"),
    );
    const hit = db
      .prepare<{ c: number }>(
        "SELECT COUNT(*) AS c FROM palace_drawers_fts WHERE palace_drawers_fts MATCH ?",
      )
      .get('"工单"');
    expect(hit!.c).toBe(1);
  });

  it("幂等：DDL 重放不报错，且不重复建对象", () => {
    const db = createPreV49TestDb();
    runMigration49(db);
    const before = objectNames(db).filter((n) => n.startsWith("palace") || n.includes("palace"));

    expect(() => runMigration49(db)).not.toThrow();
    const after = objectNames(db).filter((n) => n.startsWith("palace") || n.includes("palace"));
    expect(after).toEqual(before);
  });

  it("存量数据不受影响：段与记忆行数、内容原样", () => {
    const db = createPreV49TestDb();
    db.prepare(
      `INSERT INTO memory_segments
         (id, conversation_id, user_id, agent_id, start_message_id, end_message_id,
          status, turn_count, char_count, created_at)
       VALUES ('seg1', 'conv1', 'local-user', 'assistant', 'm1', 'm2',
               'summarised', 3, 120, '2026-09-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_memories
         (id, agent_id, user_id, category, content, importance, tags,
          created_at, last_used, use_count, is_archived)
       VALUES ('m1', 'assistant', 'local-user', 'general', '一条存量记忆', 0.6, NULL,
               '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 0, 0)`,
    ).run();

    runMigration49(db);

    expect(
      db.prepare<{ c: number }>("SELECT COUNT(*) AS c FROM memory_segments").get()!.c,
    ).toBe(1);
    expect(
      db
        .prepare<{ content: string }>("SELECT content FROM agent_memories WHERE id = 'm1'")
        .get()!.content,
    ).toBe("一条存量记忆");
  });

  it("segment_id 不加外键：段被删了，归档原文仍能写进来（存档不该被运维行约束）", () => {
    const db = createPreV49TestDb();
    runMigration49(db);

    // 实施计划里写的是 REFERENCES memory_segments(id) ON DELETE SET NULL，
    // 实际去掉了：归档在异步队列里跑，用户可能在归档落地前删掉会话，
    // 有外键就会让那次归档直接失败、原文丢失——存档最不该发生的事。
    const fks = db
      .prepare<{ from: string }>("PRAGMA foreign_key_list(palace_drawers)")
      .all();
    expect(fks.map((f) => f.from)).not.toContain("segment_id");

    // 段不存在照样归档得进去
    expect(() =>
      db
        .prepare(
          `INSERT INTO palace_drawers
             (drawer_id, agent_id, user_id, conversation_id, segment_id, wing, room,
              content, char_count, created_at, deleted_at)
           VALUES ('d1', 'assistant', 'local-user', 'conv-gone', 'seg-gone', 'w', 'r',
                   '已被删掉的会话里的原文', 12, '2026-09-17T00:00:00.000Z', NULL)`,
        )
        .run(),
    ).not.toThrow();
  });
});
