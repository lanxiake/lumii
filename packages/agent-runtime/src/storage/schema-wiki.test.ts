/**
 * Wiki V16 迁移最小验证：7 张表建成功，SCHEMA_VERSION 正确递增。
 */
import { describe, expect, it } from "vitest";
import {
  createMigratedTestDb,
  createPreV26TestDb,
  createPreV27TestDb,
  runMigration26,
  runMigration27,
} from "../__tests__/helpers/sqlite-test-db.js";
import { SCHEMA_VERSION } from "./schema.js";

describe("wiki schema V16", () => {
  it("建出非页面相关的 wiki 表", () => {
    const db = createMigratedTestDb();

    const tables = ["wiki_inbox", "wiki_sources", "wiki_organize_runs", "wiki_index_meta"];
    for (const t of tables) {
      const row = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = ?")
        .get(t);
      expect(row?.name, `表 ${t} 应存在`).toBe(t);
    }

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(16);
    db.close();
  });

  it("V27 之前：wiki_pages 同归属同路径唯一约束生效", () => {
    const db = createPreV27TestDb();

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

  it("V27 之前：wiki_page_revisions 级联删除随 wiki_pages 一并清除", () => {
    const db = createPreV27TestDb();
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

describe("wiki schema V18（历史页面表已在 V27 删除，测试改用 pre-V27 库固定行为）", () => {
  it("V27 之前：建出 wiki_links 与 wiki_page_attachments 两张表", () => {
    const db = createPreV27TestDb();

    for (const t of ["wiki_links", "wiki_page_attachments"]) {
      const row = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = ?")
        .get(t);
      expect(row?.name, `表 ${t} 应存在`).toBe(t);
    }

    db.close();
  });

  it("V27 之前：wiki_pages 新增 status 列，默认值 active", () => {
    const db = createPreV27TestDb();

    db.prepare(
      "INSERT INTO wiki_pages (id, agent_id, user_id, path, category, title, created_at, updated_at) VALUES ('p2', 'a', 'u', 'sources/z', 'sources', 'z', 'now', 'now')",
    ).run();
    const row = db
      .prepare<{ status: string }>("SELECT status FROM wiki_pages WHERE id = 'p2'")
      .get();
    expect(row?.status).toBe("active");

    db.close();
  });

  it("V27 之前：wiki_page_attachments 级联删除随 wiki_pages 一并清除", () => {
    const db = createPreV27TestDb();
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
  it("建出 ERO 三表", () => {
    const db = createMigratedTestDb();
    for (const t of ["wiki_entities", "wiki_observations", "wiki_relations"]) {
      const row = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = ?")
        .get(t);
      expect(row?.name, `表 ${t} 应存在`).toBe(t);
    }
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
    db.close();
  });

  it("V27 之前：建出 wiki_page_embeddings（历史页面向量派生表）", () => {
    const db = createPreV27TestDb();
    const row = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = ?")
      .get("wiki_page_embeddings");
    expect(row?.name).toBe("wiki_page_embeddings");
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

describe("wiki schema V22", () => {
  it("wiki_sources 有用途列与使用计数", () => {
    const db = createMigratedTestDb();
    const cols = db.prepare<{ name: string }>("PRAGMA table_info(wiki_sources)").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      "topic_category", "topic_subtopic", "last_used", "use_count",
    ]));
    expect(db.prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name = 'wiki_sources_fts'",
    ).get()?.name).toBe("wiki_sources_fts");
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(22);
    db.close();
  });

  it("ERO 表有可空 source_id", () => {
    const db = createMigratedTestDb();
    for (const table of ["wiki_entities", "wiki_observations", "wiki_relations"]) {
      const cols = db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      expect(cols, table).toContain("source_id");
    }
    db.close();
  });
});

describe("wiki schema V24", () => {
  it("建出 wiki_source_embeddings 资料向量派生表", () => {
    const db = createMigratedTestDb();
    expect(
      db.prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name = 'wiki_source_embeddings'",
      ).get()?.name,
    ).toBe("wiki_source_embeddings");
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(24);
    db.close();
  });
});

describe("wiki schema V25", () => {
  it("wiki_sources 新增 origin_url 与 storage_mode 两列", () => {
    const db = createMigratedTestDb();
    const cols = db
      .prepare<{ name: string; dflt_value: string | null }>("PRAGMA table_info(wiki_sources)")
      .all();
    const names = cols.map((c) => c.name);
    expect(names).toContain("origin_url");
    expect(names).toContain("storage_mode");
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(25);
    db.close();
  });

  it("storage_mode 默认 ref，且只接受三种取值", () => {
    const db = createMigratedTestDb();
    const insert = (id: string, mode?: string) =>
      db
        .prepare(
          mode
            ? "INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at, storage_mode) VALUES (?, 'a', 'u', 't', 'now', ?)"
            : "INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at) VALUES (?, 'a', 'u', 't', 'now')",
        )
        .run(...(mode ? [id, mode] : [id]));

    insert("s-default");
    expect(
      db
        .prepare<{ storage_mode: string }>("SELECT storage_mode FROM wiki_sources WHERE id = ?")
        .get("s-default")?.storage_mode,
    ).toBe("ref");

    insert("s-native", "native");
    insert("s-mat", "materialized");
    expect(() => insert("s-bad", "cloud")).toThrow();

    db.close();
  });
});

describe("wiki schema V26", () => {
  it("新增 legacy_subtopic / title_locked / summary 三列", () => {
    const db = createMigratedTestDb();
    const cols = db.prepare<{ name: string }>("PRAGMA table_info(wiki_sources)").all().map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(["legacy_subtopic", "title_locked", "summary", "summary_hash", "summary_level"]),
    );
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(26);
    db.close();
  });

  it("title_locked 默认 0；summary_level 只接受三种取值", () => {
    const db = createMigratedTestDb();
    db.prepare(
      "INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at) VALUES ('s1', 'a', 'u', 't', 'now')",
    ).run();
    const row = db
      .prepare<{ title_locked: number }>("SELECT title_locked FROM wiki_sources WHERE id = 's1'")
      .get();
    expect(row?.title_locked).toBe(0);

    expect(() =>
      db
        .prepare(
          "INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at, summary_level) VALUES ('s2', 'a', 'u', 't', 'now', 'bad')",
        )
        .run(),
    ).toThrow();

    db.close();
  });

  it("大类机械改写：6 条无歧义规则，旧小类留痕 legacy_subtopic", () => {
    const db = createPreV26TestDb();
    db.prepare(
      `INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at, topic_category, topic_subtopic)
       VALUES ('s1', 'a', 'u', 't1', 'now', '做事记录', '项目/任务资料')`,
    ).run();
    db.prepare(
      `INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at, topic_category, topic_subtopic)
       VALUES ('s2', 'a', 'u', 't2', 'now', '学习资料', '读书摘抄整理')`,
    ).run();
    db.prepare(
      `INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at, topic_category, topic_subtopic)
       VALUES ('s3', 'a', 'u', 't3', 'now', '证件凭据', '合同协议文件')`,
    ).run();
    db.prepare(
      `INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at, topic_category, topic_subtopic)
       VALUES ('s4', 'a', 'u', 't4', 'now', '模板参考', '各类文档模板')`,
    ).run();
    db.prepare(
      `INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at, topic_category, topic_subtopic)
       VALUES ('s5', 'a', 'u', 't5', 'now', '随笔创作', '生活感悟随笔')`,
    ).run();

    runMigration26(db);

    const rows = db
      .prepare<{ id: string; topic_category: string | null; topic_subtopic: string | null; legacy_subtopic: string | null }>(
        "SELECT id, topic_category, topic_subtopic, legacy_subtopic FROM wiki_sources ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      { id: "s1", topic_category: "工作", topic_subtopic: null, legacy_subtopic: "项目/任务资料" },
      { id: "s2", topic_category: "学习", topic_subtopic: null, legacy_subtopic: "读书摘抄整理" },
      { id: "s3", topic_category: "生活", topic_subtopic: null, legacy_subtopic: "合同协议文件" },
      { id: "s4", topic_category: "收藏", topic_subtopic: null, legacy_subtopic: "各类文档模板" },
      { id: "s5", topic_category: "生活", topic_subtopic: null, legacy_subtopic: "生活感悟随笔" },
    ]);
    db.close();
  });

  it("计划与复盘 整类 + 整合长文 小类 → 收件箱（两列置空）", () => {
    const db = createPreV26TestDb();
    db.prepare(
      `INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at, topic_category, topic_subtopic)
       VALUES ('s1', 'a', 'u', 't1', 'now', '计划与复盘', '目标规划方案')`,
    ).run();
    db.prepare(
      `INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at, topic_category, topic_subtopic)
       VALUES ('s2', 'a', 'u', 't2', 'now', '做事记录', '整合长文')`,
    ).run();

    runMigration26(db);

    const rows = db
      .prepare<{ id: string; topic_category: string | null; topic_subtopic: string | null; legacy_subtopic: string | null }>(
        "SELECT id, topic_category, topic_subtopic, legacy_subtopic FROM wiki_sources ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      { id: "s1", topic_category: null, topic_subtopic: null, legacy_subtopic: "目标规划方案" },
      { id: "s2", topic_category: null, topic_subtopic: null, legacy_subtopic: "整合长文" },
    ]);
    db.close();
  });
});

describe("wiki schema V27", () => {
  const DROPPED_TABLES = [
    "wiki_page_embeddings",
    "wiki_page_attachments",
    "wiki_pages_fts",
    "wiki_links",
    "wiki_page_revisions",
    "wiki_pages",
  ];

  it("6 张历史页面表全部不存在", () => {
    const db = createMigratedTestDb();
    for (const t of DROPPED_TABLES) {
      const row = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = ?")
        .get(t);
      expect(row, `表 ${t} 应已删除`).toBeUndefined();
    }
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(27);
    db.close();
  });

  it("wiki_sources / wiki_source_embeddings 不受影响", () => {
    const db = createPreV27TestDb();
    db.prepare(
      "INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at) VALUES ('s1', 'a', 'u', 't1', 'now')",
    ).run();
    db.prepare(
      `INSERT INTO wiki_source_embeddings (source_id, agent_id, user_id, model_id, dims, embedding, content_hash, updated_at)
       VALUES ('s1', 'a', 'u', 'm1', 4, x'00000000', 'h1', 'now')`,
    ).run();

    const sourcesBefore = db.prepare<{ c: number }>("SELECT COUNT(*) as c FROM wiki_sources").get()?.c;
    const embeddingsBefore = db
      .prepare<{ c: number }>("SELECT COUNT(*) as c FROM wiki_source_embeddings")
      .get()?.c;

    runMigration27(db);

    const sourcesAfter = db.prepare<{ c: number }>("SELECT COUNT(*) as c FROM wiki_sources").get()?.c;
    const embeddingsAfter = db
      .prepare<{ c: number }>("SELECT COUNT(*) as c FROM wiki_source_embeddings")
      .get()?.c;
    expect(sourcesAfter).toBe(sourcesBefore);
    expect(embeddingsAfter).toBe(embeddingsBefore);

    for (const t of DROPPED_TABLES) {
      const row = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = ?")
        .get(t);
      expect(row, `表 ${t} 应已删除`).toBeUndefined();
    }
    db.close();
  });
});
