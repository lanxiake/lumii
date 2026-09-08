/**
 * BashCommandRepo — bash 工具调用记录仓库
 *
 * 逐条记录 bash 工具的 command 原文与执行结果元数据（schema V36），
 * 供「工具进化」管道（命令模式挖掘 → 草拟参数化工具）使用。
 * 与 tool_audit_log 的区别：audit 只存结果摘要，本表存命令原文。
 */

import type { DatabaseAdapter } from "./local-database.js";

/** 单条 bash 调用记录 */
export interface BashCommandRow {
  readonly id: number;
  readonly agent_id: string;
  readonly conversation_id: string | null;
  readonly tool_call_id: string;
  readonly command: string;
  readonly cwd: string | null;
  readonly is_error: number;
  readonly duration_ms: number | null;
  readonly created_at: string;
}

export interface BashCommandLogParams {
  readonly agentId: string;
  readonly conversationId?: string;
  readonly toolCallId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly isError?: boolean;
  readonly durationMs?: number;
}

export class BashCommandRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /** 记录一次 bash 工具调用 */
  log(params: BashCommandLogParams): void {
    this.db
      .prepare(
        `INSERT INTO bash_command_log
           (agent_id, conversation_id, tool_call_id, command, cwd, is_error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.agentId,
        params.conversationId ?? null,
        params.toolCallId,
        params.command,
        params.cwd ?? null,
        params.isError ? 1 : 0,
        params.durationMs ?? null,
        new Date().toISOString(),
      );
  }

  /** 拉取用于挖掘的近期记录（升序） */
  listRecent(limit = 2000): readonly BashCommandRow[] {
    const n = Math.min(Math.max(1, limit), 20000);
    return this.db
      .prepare<BashCommandRow>(
        `SELECT id, agent_id, conversation_id, tool_call_id, command, cwd, is_error, duration_ms, created_at
         FROM bash_command_log
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(n);
  }

  /** 清理早于 cutoff（ISO 字符串）的记录，控制库体积 */
  pruneOlderThan(cutoffIso: string): number {
    const res = this.db
      .prepare(`DELETE FROM bash_command_log WHERE created_at < ?`)
      .run(cutoffIso);
    return res.changes;
  }

  /** 记录总数（测试与统计用） */
  count(): number {
    const row = this.db
      .prepare<{ c: number }>(`SELECT COUNT(*) as c FROM bash_command_log`)
      .get();
    return row?.c ?? 0;
  }
}
