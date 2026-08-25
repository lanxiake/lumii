/**
 * Wiki V16 迁移最小验证：7 张表建成功，SCHEMA_VERSION 正确递增。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { SCHEMA_VERSION } from "./schema.js";

describe("wiki schema V16", () => {
  it("建出 7 张 wiki 表", () => {
    const db = createMigratedTestDb();

    const tables = [
      "wiki_inbox",
      "wiki_sources",
      "wiki_pages",
      "wiki_page_revisions",
      "wiki_organize_runs",
      "wiki_pages_fts",
      "wiki_index_meta",
    ];
    for (const t of tables) {
      const row = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = ?")
        .get(t);
      expect(row?.name, `表 ${t} 应存在`).toBe(t);
    }

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(16);
    db.close();
  });

  it("wiki_pages 同归属同路径唯一约束生效", () => {
    const db = createMigratedTestDb();

    const insert = () =>
      db
        .prepare(
          "INSERT INTO wiki_pages (id, agent_id, user_id, path, category, title, created_at, updated_at) VALUES (?, 'a', 'u', 'sources/x', 'sources', 'x', 'now', 'now')",
        )
        .run(String(Math.random()));

    insert();
    expect(() => insert()).toThrow();

    db.close();
  });

  it("wiki_page_revisions 级联删除随 wiki_pages 一并清除", () => {
    const db = createMigratedTestDb();
    db.exec("PRAGMA foreign_keys=ON");

    db.prepare(
      "INSERT INTO wiki_pages (id, agent_id, user_id, path, category, title, created_at, updated_at) VALUES ('p1', 'a', 'u', 'sources/y', 'sources', 'y', 'now', 'now')",
    ).run();
    db.prepare(
      "INSERT INTO wiki_page_revisions (id, page_id, version, title, path, editor, created_at) VALUES ('r1', 'p1', 1, 'y', 'sources/y', 'ai', 'now')",
    ).run();

    db.prepare("DELETE FROM wiki_pages WHERE id = 'p1'").run();
    const remaining = db
      .prepare<{ c: number }>("SELECT COUNT(*) as c FROM wiki_page_revisions WHERE page_id = 'p1'")
      .get();
    expect(remaining?.c).toBe(0);

    db.close();
  });
});
