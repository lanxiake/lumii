/**
 * SegmentRepo — 记忆分段（memory_segments）持久化
 *
 * 段落总结提取（记忆系统升级阶段①）的存储层：
 * - 段用 message-id 区间锚定（非 turnIndex，后者在 mtbot 不稳定）
 * - 三态：open → closed → summarised
 * - findClosed 供 SummarizationQueue worker 重启恢复（进程退出不丢未总结段）
 *
 * 设计：`.qoder/design/client-agent-runtime/2026-05-30-记忆系统升级-段落总结提取设计.md`
 */

import type { DatabaseAdapter } from "./local-database.js";

export type SegmentStatus = "open" | "closed" | "summarised";

/** 数据库行（原始 SQLite 格式） */
export interface SegmentRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly user_id: string;
  readonly agent_id: string;
  readonly start_message_id: string;
  readonly end_message_id: string | null;
  readonly status: SegmentStatus;
  readonly turn_count: number;
  readonly char_count: number;
  readonly topic_tokens: string | null; // JSON 数组
  readonly close_reason: string | null;
  readonly retry_count: number;
  readonly created_at: string;
  readonly closed_at: string | null;
  readonly summarised_at: string | null;
  readonly palace_drawer_id: string | null;
}

/** 领域对象 */
export interface MemorySegment {
  readonly id: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly startMessageId: string;
  readonly endMessageId: string | null;
  readonly status: SegmentStatus;
  readonly turnCount: number;
  readonly charCount: number;
  readonly topicTokens: readonly string[];
  readonly closeReason: string | null;
  readonly retryCount: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly summarisedAt: string | null;
  /** 该段原文在记忆宫殿中的归档位置（内容寻址 drawer_id），可空 */
  readonly palaceDrawerId: string | null;
}

export interface CreateSegmentParams {
  readonly id: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly startMessageId: string;
  readonly topicTokens?: readonly string[];
}

/** 累积更新（observe 把一轮并入当前 open 段时调用） */
export interface AppendSegmentParams {
  readonly endMessageId: string;
  readonly turnCount: number;
  readonly charCount: number;
  readonly topicTokens: readonly string[];
}

function rowToSegment(row: SegmentRow): MemorySegment {
  let topicTokens: readonly string[] = [];
  if (row.topic_tokens) {
    try {
      const parsed: unknown = JSON.parse(row.topic_tokens);
      if (Array.isArray(parsed)) topicTokens = parsed.filter((t): t is string => typeof t === "string");
    } catch {
      // 容错：损坏的 JSON 视为空
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    agentId: row.agent_id,
    startMessageId: row.start_message_id,
    endMessageId: row.end_message_id,
    status: row.status,
    turnCount: row.turn_count,
    charCount: row.char_count,
    topicTokens,
    closeReason: row.close_reason,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    summarisedAt: row.summarised_at,
    palaceDrawerId: row.palace_drawer_id,
  };
}

export class SegmentRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /** 新建 open 段 */
  create(params: CreateSegmentParams): MemorySegment {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO memory_segments
         (id, conversation_id, user_id, agent_id, start_message_id, end_message_id,
          status, turn_count, char_count, topic_tokens, close_reason, retry_count,
          created_at, closed_at, summarised_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', 1, 0, ?, NULL, 0, ?, NULL, NULL)`,
      )
      .run(
        params.id,
        params.conversationId,
        params.userId,
        params.agentId,
        params.startMessageId,
        params.startMessageId, // 初始 end = start（首轮）
        JSON.stringify(params.topicTokens ?? []),
        now,
      );
    return this.findById(params.id)!;
  }

  findById(id: string): MemorySegment | null {
    const row = this.db
      .prepare<SegmentRow>("SELECT * FROM memory_segments WHERE id = ?")
      .get(id);
    return row ? rowToSegment(row) : null;
  }

  /** 取某会话当前 open 段（约定至多一个） */
  findOpenByConversation(conversationId: string): MemorySegment | null {
    const row = this.db
      .prepare<SegmentRow>(
        "SELECT * FROM memory_segments WHERE conversation_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1",
      )
      .get(conversationId);
    return row ? rowToSegment(row) : null;
  }

  /** 把一轮并入当前 open 段（更新 end/计数/topic 指纹） */
  append(id: string, params: AppendSegmentParams): void {
    this.db
      .prepare(
        `UPDATE memory_segments
         SET end_message_id = ?, turn_count = ?, char_count = ?, topic_tokens = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(
        params.endMessageId,
        params.turnCount,
        params.charCount,
        JSON.stringify(params.topicTokens),
        id,
      );
  }

  /** 关闭段：open → closed */
  close(id: string, endMessageId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE memory_segments
         SET status = 'closed', end_message_id = ?, close_reason = ?, closed_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(endMessageId, reason, new Date().toISOString(), id);
  }

  /** 标记已总结：closed → summarised */
  markSummarised(id: string): void {
    this.db
      .prepare(
        "UPDATE memory_segments SET status = 'summarised', summarised_at = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), id);
  }

  /** 总结失败：retry_count + 1，返回更新后的值 */
  incrementRetry(id: string): number {
    this.db
      .prepare("UPDATE memory_segments SET retry_count = retry_count + 1 WHERE id = ?")
      .run(id);
    return this.findById(id)?.retryCount ?? 0;
  }

  /**
   * 取待总结的 closed 段（worker 重启恢复用）。
   * 按创建时间升序，保证先进先总结。
   */
  findClosed(limit = 20): MemorySegment[] {
    return this.db
      .prepare<SegmentRow>(
        "SELECT * FROM memory_segments WHERE status = 'closed' ORDER BY created_at ASC LIMIT ?",
      )
      .all(limit)
      .map(rowToSegment);
  }

  /**
   * 取所有 open 段（跨会话）。用于 app 退出前 flushAll：
   * 把残留 open 段关闭为 closed，下次启动由 findClosed 重启恢复总结。
   */
  findAllOpen(limit = 200): MemorySegment[] {
    return this.db
      .prepare<SegmentRow>(
        "SELECT * FROM memory_segments WHERE status = 'open' ORDER BY created_at ASC LIMIT ?",
      )
      .all(limit)
      .map(rowToSegment);
  }

  /** 删除某会话所有段（会话清空时级联清理） */
  deleteByConversation(conversationId: string): void {
    this.db
      .prepare("DELETE FROM memory_segments WHERE conversation_id = ?")
      .run(conversationId);
  }

  /** 回填段的宫殿归档 drawer_id（段原文归档后） */
  setPalaceDrawerId(id: string, drawerId: string): void {
    this.db
      .prepare("UPDATE memory_segments SET palace_drawer_id = ? WHERE id = ?")
      .run(drawerId, id);
  }
}
