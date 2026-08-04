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
  readonly args_hash: string | null;
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
    readonly argsHash?: string;
    readonly resultSummary?: string;
    readonly isError?: boolean;
    readonly durationMs?: number;
  }): void {
    const now = new Date().toISOString();
    // 完整存储 result_summary，不做截断，方便用户查看和调试
    const summary = params.resultSummary ?? null;

    this.db
      .prepare(
        `INSERT INTO tool_audit_log (agent_id, tool_name, args_hash, result_summary, is_error, duration_ms, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.agentId,
        params.toolName,
        params.argsHash ?? null,
        summary,
        params.isError ? 1 : 0,
        params.durationMs ?? null,
        now,
      );
  }

  /**
   * 记录 LLM 调用的 token 使用量（作为特殊工具日志）
   */
  logLlmUsage(params: {
    readonly agentId: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly durationMs?: number;
  }): void {
    this.log({
      agentId: params.agentId,
      toolName: "__llm_call__",
      resultSummary: JSON.stringify({
        model: params.model,
        input: params.inputTokens,
        output: params.outputTokens,
        total: params.totalTokens,
      }),
      durationMs: params.durationMs,
    });
  }

  /**
   * 全局最近审计记录（不区分 Agent，用于设置页「安全日志」等）
   */
  listRecentGlobally(limit = 20): readonly AuditLogRow[] {
    const n = Math.min(Math.max(1, limit), 200);
    return this.db
      .prepare<AuditLogRow>(
        `SELECT * FROM tool_audit_log
       ORDER BY timestamp DESC
       LIMIT ?`,
      )
      .all(n);
  }

  /**
   * 查询指定 Agent 的最近审计日志
   */
  getRecent(agentId: string, limit = 50): readonly AuditLogRow[] {
    return this.db
      .prepare<AuditLogRow>(
        `SELECT * FROM tool_audit_log
       WHERE agent_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
      )
      .all(agentId, limit);
  }

  /**
   * 查询指定工具的最近日志
   */
  getByTool(toolName: string, limit = 50): readonly AuditLogRow[] {
    return this.db
      .prepare<AuditLogRow>(
        `SELECT * FROM tool_audit_log
       WHERE tool_name = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
      )
      .all(toolName, limit);
  }

  /**
   * 查询错误日志
   */
  getErrors(agentId?: string, limit = 50): readonly AuditLogRow[] {
    if (agentId) {
      return this.db
        .prepare<AuditLogRow>(
          `SELECT * FROM tool_audit_log
         WHERE agent_id = ? AND is_error = 1
         ORDER BY timestamp DESC
         LIMIT ?`,
        )
        .all(agentId, limit);
    }
    return this.db
      .prepare<AuditLogRow>(
        `SELECT * FROM tool_audit_log
       WHERE is_error = 1
       ORDER BY timestamp DESC
       LIMIT ?`,
      )
      .all(limit);
  }

  /**
   * 统计指定 Agent 的工具使用情况
   */
  getStats(
    agentId: string,
  ): readonly { tool_name: string; call_count: number; error_count: number }[] {
    return this.db
      .prepare<{ tool_name: string; call_count: number; error_count: number }>(
        `SELECT
         tool_name,
         COUNT(*) as call_count,
         SUM(is_error) as error_count
       FROM tool_audit_log
       WHERE agent_id = ?
       GROUP BY tool_name
       ORDER BY call_count DESC`,
      )
      .all(agentId);
  }

  /**
   * 按时间窗口统计各工具调用次数、平均耗时、错误率（排除 LLM 伪工具时可在外层过滤）。
   */
  getToolUsageStats(
    agentId: string,
    days: number,
  ): ReadonlyArray<{
    readonly toolName: string;
    readonly callCount: number;
    readonly avgDuration: number;
    readonly errorRate: number;
  }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Math.max(0, days));
    const iso = cutoff.toISOString();

    const rows = this.db
      .prepare<{
        tool_name: string;
        call_count: number;
        avg_duration: number | null;
        error_rate: number | null;
      }>(
        `SELECT
         tool_name,
         COUNT(*) AS call_count,
         AVG(CASE WHEN duration_ms IS NULL THEN NULL ELSE duration_ms END) AS avg_duration,
         SUM(is_error) * 1.0 / COUNT(*) AS error_rate
       FROM tool_audit_log
       WHERE agent_id = ? AND timestamp >= ?
       GROUP BY tool_name
       ORDER BY call_count DESC`,
      )
      .all(agentId, iso);

    return rows.map((r) => ({
      toolName: r.tool_name,
      callCount: r.call_count,
      avgDuration: r.avg_duration ?? 0,
      errorRate: r.error_rate ?? 0,
    }));
  }

  /**
   * 最近失败的工具审计记录
   */
  getRecentErrors(agentId: string, limit = 50): readonly AuditLogRow[] {
    return this.getErrors(agentId, limit);
  }

  /**
   * 导出与某会话相关的工具审计为 JSON Lines（按会话关联的 agent 参与者过滤）。
   */
  exportToJSONL(conversationId: string): string {
    const rows = this.db
      .prepare<AuditLogRow>(
        `SELECT t.*
       FROM tool_audit_log t
       WHERE t.agent_id IN (
         SELECT participant_id FROM conversation_participants
         WHERE conversation_id = ? AND participant_type = 'agent'
       )
       ORDER BY t.timestamp ASC`,
      )
      .all(conversationId);

    return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  }

  /**
   * 清理超过指定天数的旧日志
   */
  pruneOlderThan(days: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const result = this.db
      .prepare("DELETE FROM tool_audit_log WHERE timestamp < ?")
      .run(cutoff.toISOString());
    return result.changes;
  }
}
