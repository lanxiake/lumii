/**
 * V36 迁移验证：bash_command_log 表（工具进化 · 命令模式挖掘数据源）。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { BashCommandRepo } from "./bash-command-repo.js";
import { SCHEMA_VERSION } from "./schema.js";

describe("schema V36 bash_command_log", () => {
  it("SCHEMA_VERSION 已递增到 36", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(36);
  });

  it("建出 bash_command_log 表", () => {
    const db = createMigratedTestDb();
    const tables = db
      .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((t) => t.name);
    expect(tables).toContain("bash_command_log");
    db.close();
  });

  it("BashCommandRepo 写入 / 查询 / 清理", () => {
    const db = createMigratedTestDb();
    const repo = new BashCommandRepo(db);
    repo.log({
      agentId: "agent-1",
      conversationId: "conv-1",
      toolCallId: "tc-1",
      command: "pnpm --filter ./apps/windows build",
      isError: false,
      durationMs: 1200,
    });
    repo.log({
      agentId: "agent-1",
      toolCallId: "tc-2",
      command: "rm -rf /tmp/x",
      isError: true,
    });
    expect(repo.count()).toBe(2);

    const rows = repo.listRecent(10);
    // 倒序返回：最新在前
    expect(rows[0]?.command).toBe("rm -rf /tmp/x");
    expect(rows[0]?.is_error).toBe(1);
    expect(rows[1]?.command).toBe("pnpm --filter ./apps/windows build");
    expect(rows[1]?.conversation_id).toBe("conv-1");
    expect(rows[1]?.duration_ms).toBe(1200);

    // 清理早于 cutoff 的记录
    const removed = repo.pruneOlderThan("2099-01-01T00:00:00.000Z");
    expect(removed).toBe(2);
    expect(repo.count()).toBe(0);
    db.close();
  });
});
