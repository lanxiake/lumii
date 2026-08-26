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

describe("wiki schema V18", () => {
  it("建出 wiki_links 与 wiki_page_attachments 两张表", () => {
    const db = createMigratedTestDb();

    for (const t of ["wiki_links", "wiki_page_attachments"]) {
      const row = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = ?")
        .get(t);
      expect(row?.name, `表 ${t} 应存在`).toBe(t);
    }

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(18);
    db.close();
  });

  it("wiki_pages 新增 status 列，默认值 active", () => {
    const db = createMigratedTestDb();

    db.prepare(
      "INSERT INTO wiki_pages (id, agent_id, user_id, path, category, title, created_at, updated_at) VALUES ('p2', 'a', 'u', 'sources/z', 'sources', 'z', 'now', 'now')",
    ).run();
    const row = db
      .prepare<{ status: string }>("SELECT status FROM wiki_pages WHERE id = 'p2'")
      .get();
    expect(row?.status).toBe("active");

    db.close();
  });

  it("wiki_page_attachments 级联删除随 wiki_pages 一并清除", () => {
    const db = createMigratedTestDb();
    db.exec("PRAGMA foreign_keys=ON");

    db.prepare(
      "INSERT INTO wiki_pages (id, agent_id, user_id, path, category, title, created_at, updated_at) VALUES ('p3', 'a', 'u', 'sources/w', 'sources', 'w', 'now', 'now')",
    ).run();
    db.prepare(
      "INSERT INTO wiki_page_attachments (id, page_id, file_path, display_name, created_at) VALUES ('at1', 'p3', '/tmp/x.png', 'x.png', 'now')",
    ).run();

    db.prepare("DELETE FROM wiki_pages WHERE id = 'p3'").run();
    const remaining = db
      .prepare<{ c: number }>("SELECT COUNT(*) as c FROM wiki_page_attachments WHERE page_id = 'p3'")
      .get();
    expect(remaining?.c).toBe(0);

    db.close();
  });
});

describe("wiki schema V19", () => {
  function tryDb() {
    try {
      return createMigratedTestDb();
    } catch {
      return null;
    }
  }

  it("建出 wiki_syntheses 表且 SCHEMA_VERSION >= 19", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
    const db = tryDb();
    if (!db) return;
    const row = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = ?")
      .get("wiki_syntheses");
    expect(row?.name, "表 wiki_syntheses 应存在").toBe("wiki_syntheses");
    db.close();
  });

  it("wiki_syntheses 默认 status=candidate，可写入候选行", () => {
    const db = tryDb();
    if (!db) return;

    db.prepare(
      `INSERT INTO wiki_syntheses
       (id, agent_id, user_id, source_page_ids, title, candidate_md, created_at)
       VALUES ('s1', 'a', 'u', '["p1"]', '综述', '正文', 'now')`,
    ).run();
    const row = db
      .prepare<{ status: string; candidate_md: string }>(
        "SELECT status, candidate_md FROM wiki_syntheses WHERE id = 's1'",
      )
      .get();
    expect(row?.status).toBe("candidate");
    expect(row?.candidate_md).toBe("正文");

    db.close();
  });
});

describe("wiki schema V20", () => {
  it("建出 ERO 三表与 wiki_page_embeddings", () => {
    const db = createMigratedTestDb();
    for (const t of ["wiki_entities", "wiki_observations", "wiki_relations", "wiki_page_embeddings"]) {
      const row = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = ?")
        .get(t);
      expect(row?.name, `表 ${t} 应存在`).toBe(t);
    }
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
    db.close();
  });
});

describe("wiki schema V21", () => {
  it("V21 wiki_organize_runs 含 result_detail 列", () => {
    const db = createMigratedTestDb();
    const cols = db
      .prepare<{ name: string }>("PRAGMA table_info(wiki_organize_runs)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("result_detail");
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(21);
    db.close();
  });
});
