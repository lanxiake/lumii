/**
 * AuditRepo — 工具审计日志写入
 *
 * 记录每次工具调用的元数据，用于本地审计和调试。
 */

import type { DatabaseAdapter } from "./local-database.js";

// ─── 类型定义 ───

export interface AuditLogRow {
  readonly id: number;
  readonly agent_id: string;
  readonly tool_name: string;
  readonly result_summary: string | null;
  readonly is_error: number;
  readonly duration_ms: number | null;
  readonly timestamp: string;
}

// ─── Repo 实现 ───

export class AuditRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /**
   * 记录一次工具执行
   */
  log(params: {
    readonly agentId: string;
    readonly toolName: string;
    readonly resultSummary?: string;
    readonly isError?: boolean;
    readonly durationMs?: number;
  }): void {
    const now = new Date().toISOString();
    // 完整存储 result_summary，不做截断，方便用户查看和调试
    const summary = params.resultSummary ?? null;

    this.db
      .prepare(
        `INSERT INTO tool_audit_log (agent_id, tool_name, result_summary, is_error, duration_ms, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.agentId,
        params.toolName,
        summary,
        params.isError ? 1 : 0,
        params.durationMs ?? null,
        now,
      );
  }

  /**
   * 全局最近审计记录（不区分 Agent，用于设置页「安全日志」等）
   */
  listRecentGlobally(limit = 20): readonly AuditLogRow[] {
    const n = Math.min(Math.max(1, limit), 200);
    return this.db
      .prepare<AuditLogRow>(
        `SELECT id, agent_id, tool_name, result_summary, is_error, duration_ms, timestamp
       FROM tool_audit_log
       ORDER BY timestamp DESC
       LIMIT ?`,
      )
      .all(n);
  }
}
