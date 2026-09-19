/**
 * V52 迁移验证：`tool_audit_log` 增加来源维度（source）。
 *
 * 动因（工具面治理执行计划 §二 场景 6 / §三 0.5）：这张表有三个写入点
 * （LLM 请求审计 / 权限决策 / 工具执行失败），语义互不相同却共用 `is_error`。
 * 实测 `SELECT COUNT(*) WHERE tool_name='bash'` 得到的是**权限检查次数**而非调用次数，
 * 且「越失败的工具出现次数越多」——排序是反的。本表被用来做去掉哪个工具的决策，
 * 名实不符已到影响决策的程度。
 *
 * 本用例守住：
 * 1. 列与索引建出来，且默认值语义 = 「不假装能归因」
 * 2. 历史回填只认 llm: 前缀；permission 与 tool 历史行刻意留 'unknown'
 * 3. 存量数据一字不改（只加列，不动既有行内容）
 * 4. 三个写入点经 AuditRepo.log 落库时 source 正确分流
 */
import { describe, expect, it } from "vitest";
import { AuditRepo } from "./audit-repo.js";
import {
  createMigratedTestDb,
  createPreV52TestDb,
  runMigration52,
} from "../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "./local-database.js";
import { SCHEMA_VERSION } from "./schema.js";

interface ColumnInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
}

interface SourceRow {
  tool_name: string;
  source: string;
  is_error: number;
}

function columns(db: DatabaseAdapter, table: string): ColumnInfo[] {
  return db.prepare<ColumnInfo>(`PRAGMA table_info(${table})`).all();
}

function insertLegacyAudit(db: DatabaseAdapter, toolName: string, isError: 0 | 1): void {
  db.prepare(
    `INSERT INTO tool_audit_log (agent_id, tool_name, result_summary, is_error, timestamp)
     VALUES ('agent-1', ?, '历史行', ?, '2026-09-17T00:00:00.000Z')`,
  ).run(toolName, isError);
}

describe("V52 迁移：tool_audit_log 来源维度", () => {
  it("SCHEMA_VERSION 已递增到 52", () => {
    expect(SCHEMA_VERSION).toBe(52);
  });

  it("新建库直接带 source 列：NOT NULL，默认 'unknown'（不假装能归因）", () => {
    const db = createMigratedTestDb();
    const col = columns(db, "tool_audit_log").find((c) => c.name === "source");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toBe("'unknown'");
    db.close();
  });

  it("不显式传 source 的写入落 'unknown'（只服务历史行语义）", () => {
    const db = createMigratedTestDb();
    db.prepare(
      `INSERT INTO tool_audit_log (agent_id, tool_name, is_error, timestamp)
       VALUES ('agent-1', 'bash', 0, '2026-09-19T00:00:00.000Z')`,
    ).run();
    const row = db.prepare<{ source: string }>(`SELECT source FROM tool_audit_log`).get();
    expect(row?.source).toBe("unknown");
    db.close();
  });

  it("历史回填只认 llm: 前缀；permission / tool 两类留 'unknown'", () => {
    const db = createPreV52TestDb();
    expect(columns(db, "tool_audit_log").map((c) => c.name)).not.toContain("source");
    insertLegacyAudit(db, "llm:anthropic:claude-opus-4-7", 1);
    insertLegacyAudit(db, "bash", 0); // 权限决策行（result_summary='允许(仅本次)'）
    insertLegacyAudit(db, "bash", 1); // 工具失败行

    runMigration52(db);

    const rows = db
      .prepare<SourceRow>(
        `SELECT tool_name, source, is_error FROM tool_audit_log ORDER BY rowid`,
      )
      .all();
    expect(rows).toEqual([
      { tool_name: "llm:anthropic:claude-opus-4-7", source: "llm", is_error: 1 },
      { tool_name: "bash", source: "unknown", is_error: 0 },
      { tool_name: "bash", source: "unknown", is_error: 1 },
    ]);
    db.close();
  });

  it("只加列：既有行的其它字段一字不改", () => {
    const db = createPreV52TestDb();
    db.prepare(
      `INSERT INTO tool_audit_log (agent_id, definition_id, tool_name, result_summary, is_error, duration_ms, timestamp)
       VALUES ('agent-1', 'system-keeper', 'bash', '允许(仅本次)', 0, 42, '2026-09-17T00:00:00.000Z')`,
    ).run();

    runMigration52(db);

    const row = db
      .prepare<{
        definition_id: string;
        result_summary: string;
        duration_ms: number;
      }>(
        `SELECT definition_id, result_summary, duration_ms FROM tool_audit_log WHERE timestamp = '2026-09-17T00:00:00.000Z'`,
      )
      .get();
    expect(row?.definition_id).toBe("system-keeper");
    expect(row?.result_summary).toBe("允许(仅本次)");
    expect(row?.duration_ms).toBe(42);
    db.close();
  });

  it("建出按 (source, timestamp) 的索引（A5 验收查询走这条）", () => {
    const db = createPreV52TestDb();
    runMigration52(db);
    const idx = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tool_audit_source'",
      )
      .get();
    expect(idx?.name).toBe("idx_tool_audit_source");
    db.close();
  });

  it("重放会报 duplicate column —— 迁移不做幂等 DDL，靠版本号守卫（固化这条认识）", () => {
    // 记下这个事实：guard（isMigrationAlreadyApplied）一旦被误删，这里立刻红。
    const db = createPreV52TestDb();
    runMigration52(db);
    expect(() => runMigration52(db)).toThrow(/duplicate column name/i);
    db.close();
  });

  it("AuditRepo.log 三个写入点的 source 分流正确", () => {
    const db = createMigratedTestDb();
    const repo = new AuditRepo(db);
    repo.log({ agentId: "a", toolName: "llm:zai:glm-4.7", source: "llm", isError: true });
    repo.log({ agentId: "a", toolName: "bash", resultSummary: "允许(仅本次)", source: "permission" });
    repo.log({ agentId: "a", toolName: "file_read", isError: true, source: "tool" });

    const rows = db
      .prepare<{ tool_name: string; source: string }>(
        `SELECT tool_name, source FROM tool_audit_log ORDER BY rowid`,
      )
      .all();
    expect(rows).toEqual([
      { tool_name: "llm:zai:glm-4.7", source: "llm" },
      { tool_name: "bash", source: "permission" },
      { tool_name: "file_read", source: "tool" },
    ]);
    db.close();
  });
});
