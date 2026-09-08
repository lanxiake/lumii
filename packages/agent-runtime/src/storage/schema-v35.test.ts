/**
 * V35 迁移验证：资讯存储（dashboard_feed_meta / dashboard_feed_items）+ 记忆脏数据清理。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb, createTestSqliteAdapter } from "../__tests__/helpers/sqlite-test-db.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

describe("schema V35", () => {
  it("SCHEMA_VERSION 已递增到 35", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(35);
  });

  it("建出 dashboard_feed_meta / dashboard_feed_items 两张表", () => {
    const db = createMigratedTestDb();
    const tables = db
      .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((t) => t.name);
    expect(tables).toContain("dashboard_feed_meta");
    expect(tables).toContain("dashboard_feed_items");
    db.close();
  });

  it("dashboard_feed_items 按 id 去重主键，允许按 feed_id 查询", () => {
    const db = createMigratedTestDb();
    db.prepare(
      `INSERT INTO dashboard_feed_items (id, feed_id, title, timestamp, created_at)
       VALUES ('n1', 'news', '标题', 100, '2026-09-08T00:00:00.000Z')`,
    ).run();
    const row = db
      .prepare<{ id: string; feed_id: string; title: string }>(
        `SELECT id, feed_id, title FROM dashboard_feed_items WHERE feed_id = 'news'`,
      )
      .get();
    expect(row?.id).toBe("n1");
    expect(row?.feed_id).toBe("news");
    expect(row?.title).toBe("标题");
    db.close();
  });

  it("清理 id IS NULL 的记忆行与按内容去重的重复行", () => {
    const db = createTestSqliteAdapter();
    for (const [, sql] of MIGRATIONS) db.exec(sql);

    // 历史脏数据：两条 id IS NULL + 一条重复内容（非空 id，模拟 (agent,user,category,content) 重复）
    db.prepare(
      `INSERT INTO agent_memories (id, agent_id, user_id, category, content, created_at, last_used)
       VALUES (NULL, 'assistant', 'local-user', 'user', '喜欢爬山', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_memories (id, agent_id, user_id, category, content, created_at, last_used)
       VALUES (NULL, 'assistant', 'local-user', 'feedback', '用 Docker', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_memories (id, agent_id, user_id, category, content, created_at, last_used)
       VALUES ('m-keep', 'assistant', 'local-user', 'project', '保一条', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')`,
    ).run();
    // 重复内容（保留 MIN(rowid) 的那条）
    db.prepare(
      `INSERT INTO agent_memories (id, agent_id, user_id, category, content, created_at, last_used)
       VALUES ('m-dup-1', 'assistant', 'local-user', 'project', '重复内容', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_memories (id, agent_id, user_id, category, content, created_at, last_used)
       VALUES ('m-dup-2', 'assistant', 'local-user', 'project', '重复内容', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
    ).run();

    const v35 = MIGRATIONS.find(([version]) => version === 35);
    expect(v35).toBeTruthy();
    db.exec(v35![1]);

    const total = db.prepare<{ c: number }>(`SELECT COUNT(*) as c FROM agent_memories`).get();
    expect(total?.c).toBe(2); // 保一条 + 重复内容里保留一条

    const nullRows = db
      .prepare<{ c: number }>(`SELECT COUNT(*) as c FROM agent_memories WHERE id IS NULL`)
      .get();
    expect(nullRows?.c).toBe(0);
    db.close();
  });
});
