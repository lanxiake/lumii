/**
 * V53 迁移验证：`autonomous_satisfaction_scores` 补三列
 * （`task_summary` / `tool_call_count` / `error_count`）。
 *
 * 背景：V53 是在 `SCHEMA_VERSION` 仍写 52 时发布的（commit 3cd4d34e 漏了 bump）。
 * 由于 `migrate()` 的入口是 `if (currentVersion >= SCHEMA_VERSION) return`，已经
 * 把版本记成 52 的库**永远不会**进迁移循环，V53 因此从未落到它们头上——正是 V53
 * 注释里描述的那个「反思引擎读的列从不存在」现象。
 *
 * 本用例守住两件事：
 * 1. 版本号必须真的推进过 V53，否则老库依旧被挡在门外；
 * 2. bump 之后，两条到达路径都不能出事：
 *    - 停在 52、从没跑过 V53 的库 → 要补上三列；
 *    - 停在 52、但 ≤51 升级时顺带跑过 V53 的库（列已存在）→ 守卫要跳过，不能撞
 *      duplicate column（迁移不做幂等 DDL，这一点在 schema-v52.test.ts 里固化了）。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb, createTestSqliteAdapter } from "../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "./local-database.js";
import { LocalDatabase } from "./local-database.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

const TABLE = "autonomous_satisfaction_scores";
const V53_COLUMNS = ["task_summary", "tool_call_count", "error_count"] as const;

function columnNames(db: DatabaseAdapter): string[] {
  return db
    .prepare<{ name: string }>(`PRAGMA table_info(${TABLE})`)
    .all()
    .map((c) => c.name);
}

/**
 * 造一个「版本已记成 52」的库；withV53Columns=true 时先跑一遍 V53，
 * 模拟「从 ≤51 升级、顺带跑过 V53 却把版本记成 52」的那条路径。
 */
function buildDbRecordedAtV52(withV53Columns: boolean): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [version, sql] of MIGRATIONS) {
    if (version >= 53) continue;
    db.exec(sql);
  }
  if (withV53Columns) {
    const entry = MIGRATIONS.find(([version]) => version === 53);
    if (!entry) throw new Error("V53 migration not found in MIGRATIONS");
    db.exec(entry[1]);
  }
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at) VALUES ('schemaVersion', ?, ?)`,
  ).run("52", new Date().toISOString());
  return db;
}

describe("V53 迁移：满意度评分补三列", () => {
  it("SCHEMA_VERSION 已真正推进到 53（否则停在 52 的老库永远进不了迁移循环）", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(53);
  });

  it("V53 迁移在 MIGRATIONS 中，补的正是那三列", () => {
    const entry = MIGRATIONS.find(([version]) => version === 53);
    expect(entry).toBeDefined();
    for (const column of V53_COLUMNS) {
      expect(entry![1]).toMatch(
        new RegExp(`ALTER TABLE ${TABLE} ADD COLUMN ${column}`),
      );
    }
  });

  it("新建库直接带三列", () => {
    const db = createMigratedTestDb();
    expect(columnNames(db)).toEqual(expect.arrayContaining([...V53_COLUMNS]));
    db.close();
  });

  it("停在 52、从没跑过 V53 的老库：打开时补上三列", () => {
    const db = buildDbRecordedAtV52(false);
    expect(columnNames(db)).not.toContain("task_summary");

    new LocalDatabase().openWith(db);

    expect(columnNames(db)).toEqual(expect.arrayContaining([...V53_COLUMNS]));
    db.close();
  });

  it("停在 52、但已跑过 V53 的老库：守卫跳过重放，不报 duplicate column", () => {
    const db = buildDbRecordedAtV52(true);
    expect(columnNames(db)).toContain("task_summary");

    const ldb = new LocalDatabase();
    expect(() => ldb.openWith(db)).not.toThrow();

    expect(columnNames(db)).toEqual(expect.arrayContaining([...V53_COLUMNS]));
    db.close();
  });
});
