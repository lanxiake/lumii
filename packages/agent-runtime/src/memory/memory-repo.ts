/**
 * AgentMemoryRepo — Agent 记忆 CRUD
 *
 * 基于 SQLite 的 agent_memories 表，提供记忆的加载、保存、归档和搜索。
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { withTransaction } from "../storage/local-database.js";
import type { MemoryEntry, MemoryRow, MemoryCategory, HotMemoryConfig } from "./types.js";
import { DEFAULT_HOT_MEMORY_CONFIG, isPersonalCategory } from "./types.js";
import { tokenizeForRelevance, overlapCoefficient } from "./segmentation.js";

/** 粗估 token 数（中文约 2 字符 = 1 token，英文约 4 字符 = 1 token） */
function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2e80) cjk++;
  }
  const latin = text.length - cjk;
  return Math.ceil(cjk / 2 + latin / 4);
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    ...row,
    category: row.category as MemoryCategory,
    tags: row.tags ? JSON.parse(row.tags) : [],
    is_archived: row.is_archived === 1,
  };
}

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class AgentMemoryRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /**
   * 加载热记忆：按 importance 降序取候选集，内存中按 score 重排序，
   * 截断到 maxItems 和 maxTokenBudget，更新 last_used 和 use_count。
   *
   * @param query 可选，当前用户消息。提供且有效 token 达门槛时，叠加关键词相关性加分
   *   （overlap 系数），让召回偏向"与当前对话相关"而非仅"重要"。相关性是加分项非过滤项，
   *   重要记忆不会被排除。query 为空/过短时退化为纯标量评分（行为同现状）。
   */
  loadTopMemories(
    agentId: string,
    userId: string,
    config: HotMemoryConfig = DEFAULT_HOT_MEMORY_CONFIG,
    query?: string,
  ): readonly MemoryEntry[] {
    // query 质量门槛：有效 token 达标才启用相关性（用停用词过滤后的 token 判断）
    const minQueryTokens = config.minQueryTokens ?? 2;
    const queryTokens = query ? tokenizeForRelevance(query) : null;
    const useRelevance = !!queryTokens && queryTokens.size >= minQueryTokens;
    const relevanceBonus = config.relevanceBonus ?? 1.0;

    // 1. 从 SQLite 取候选（启用相关性时取更宽，避免高相关低重要项被 importance 预筛挡掉）
    const candidateLimit = useRelevance
      ? Math.max(config.maxItems * 2.5, 200)
      : Math.max(config.maxItems * 2.5, 50);
    const rows = this.db
      .prepare<MemoryRow>(
        `SELECT * FROM agent_memories
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0
       ORDER BY importance DESC
       LIMIT ?`,
      )
      .all(agentId, userId, candidateLimit);

    // 2. 计算 score（含相关性）
    const now = Date.now();
    const scored = rows.map((row) => {
      const daysSinceUse = (now - new Date(row.last_used).getTime()) / (1000 * 60 * 60 * 24);
      const recencyBonus = 0.1 * Math.max(0, 1 - daysSinceUse / 30);
      const weight = config.categoryWeights[row.category as MemoryCategory] ?? 1.0;
      const relevance = useRelevance
        ? overlapCoefficient(queryTokens, tokenizeForRelevance(row.content))
        : 0;
      const score = row.importance * weight + recencyBonus + relevanceBonus * relevance;
      return { row, score, relevance };
    });

    // 2.1 相关性门控：有有效 query 时，上下文类记忆（project/reference/general）
    //     与当前对话完全无关（relevance=0）则不注入——避免"问骑车却注入无关旅行记忆"。
    //     画像类（user/feedback）是稳定身份/偏好，始终保留。
    const gateContextual = useRelevance && (config.gateContextualByRelevance ?? true);
    const gated = gateContextual
      ? scored.filter(
          ({ row, relevance }) =>
            isPersonalCategory(row.category as MemoryCategory) || relevance > 0,
        )
      : scored;

    gated.sort((a, b) => b.score - a.score);

    // 2.5 按 content 去重（同内容保留 score 最高的一条，消除历史重复记录影响）
    const seenContent = new Set<string>();
    const dedupedScored = gated.filter(({ row }) => {
      const key = `${row.category}:${row.content}`;
      if (seenContent.has(key)) return false;
      seenContent.add(key);
      return true;
    });

    // 3. 按 token 预算截取
    const selected: MemoryRow[] = [];
    let tokenSum = 0;
    for (const { row } of dedupedScored) {
      if (selected.length >= config.maxItems) break;
      const tokens = estimateTokens(row.content);
      if (tokenSum + tokens > config.maxTokenBudget && selected.length > 0) break;
      selected.push(row);
      tokenSum += tokens;
    }

    // 4. 批量更新 last_used 和 use_count
    if (selected.length > 0) {
      const nowIso = new Date().toISOString();
      const updateStmt = this.db.prepare(
        "UPDATE agent_memories SET last_used = ?, use_count = use_count + 1 WHERE id = ?",
      );
      withTransaction(this.db, () => {
        for (const row of selected) {
          updateStmt.run(nowIso, row.id);
        }
      });
    }

    return selected.map(rowToEntry);
  }

  /**
   * 保存候选记忆。相同 agent+user+category+content 的活跃记忆已存在时跳过（幂等写入）。
   */
  saveCandidate(params: {
    readonly agentId: string;
    readonly userId: string;
    readonly category: MemoryCategory;
    readonly content: string;
    readonly importance?: number;
    readonly tags?: readonly string[];
    readonly sourceMessageId?: string;
    readonly sourceSegmentId?: string;
    readonly palaceDrawerId?: string;
  }): MemoryEntry {
    // 去重检查：相同 agent/user/category/content 且未归档时直接返回已有记录
    const existing = this.db
      .prepare<MemoryRow>(
        `SELECT * FROM agent_memories
       WHERE agent_id = ? AND user_id = ? AND category = ? AND content = ? AND is_archived = 0
       LIMIT 1`,
      )
      .get(params.agentId, params.userId, params.category, params.content);
    if (existing) {
      return rowToEntry(existing);
    }

    const id = generateId();
    const now = new Date().toISOString();
    const importance = params.importance ?? 0.5;
    const tagsJson = params.tags ? JSON.stringify(params.tags) : null;

    this.db
      .prepare(
        `INSERT INTO agent_memories
         (id, agent_id, user_id, category, content, importance, tags,
          source_message_id, source_segment_id, palace_drawer_id,
          created_at, last_used, use_count, is_archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(
        id,
        params.agentId,
        params.userId,
        params.category,
        params.content,
        importance,
        tagsJson,
        params.sourceMessageId ?? null,
        params.sourceSegmentId ?? null,
        params.palaceDrawerId ?? null,
        now,
        now,
      );

    return {
      id,
      agent_id: params.agentId,
      user_id: params.userId,
      category: params.category,
      content: params.content,
      importance,
      tags: params.tags ? [...params.tags] : [],
      source_message_id: params.sourceMessageId ?? null,
      source_segment_id: params.sourceSegmentId ?? null,
      palace_drawer_id: params.palaceDrawerId ?? null,
      created_at: now,
      last_used: now,
      use_count: 0,
      is_archived: false,
    };
  }

  /** 更新记忆重要度 */
  updateImportance(memoryId: string, newImportance: number): void {
    const clamped = Math.max(0, Math.min(1, newImportance));
    this.db
      .prepare("UPDATE agent_memories SET importance = ?, last_used = ? WHERE id = ?")
      .run(clamped, new Date().toISOString(), memoryId);
  }

  /**
   * 合并更新：tags（并集后）+ importance（取高），并刷新 last_used。用于去重合并写入。
   *
   * 来源补填（诉求 A）：命中已有记忆时，若旧记忆 source_segment_id 为空且本次带来源，
   * 则补填；非空则保留最早来源（最早证据优先，符合 attribution 语义）。
   */
  updateMergedFields(
    memoryId: string,
    tags: readonly string[],
    importance: number,
    source?: { readonly segmentId?: string; readonly messageId?: string },
  ): void {
    const clamped = Math.max(0, Math.min(1, importance));
    this.db
      .prepare("UPDATE agent_memories SET tags = ?, importance = ?, last_used = ? WHERE id = ?")
      .run(JSON.stringify(tags), clamped, new Date().toISOString(), memoryId);

    // 来源补填：仅当现有为空时填入，保留最早来源
    if (source?.segmentId) {
      this.db
        .prepare(
          `UPDATE agent_memories SET source_segment_id = ?
           WHERE id = ? AND source_segment_id IS NULL`,
        )
        .run(source.segmentId, memoryId);
    }
    if (source?.messageId) {
      this.db
        .prepare(
          `UPDATE agent_memories SET source_message_id = ?
           WHERE id = ? AND source_message_id IS NULL`,
        )
        .run(source.messageId, memoryId);
    }
  }

  /** 回填某记忆的宫殿 drawer_id（段原文归档拿到稳定 ID 后） */
  setPalaceDrawerId(memoryId: string, drawerId: string): void {
    this.db
      .prepare("UPDATE agent_memories SET palace_drawer_id = ? WHERE id = ?")
      .run(drawerId, memoryId);
  }

  /** 批量回填某来源段产出的所有记忆的宫殿 drawer_id */
  setPalaceDrawerIdBySegment(segmentId: string, drawerId: string): void {
    this.db
      .prepare("UPDATE agent_memories SET palace_drawer_id = ? WHERE source_segment_id = ?")
      .run(drawerId, segmentId);
  }

  /** 读取单条记忆（含来源字段），用于来源下转 */
  findById(memoryId: string): MemoryEntry | null {
    const row = this.db
      .prepare<MemoryRow>("SELECT * FROM agent_memories WHERE id = ?")
      .get(memoryId);
    return row ? rowToEntry(row) : null;
  }

  /** 归档记忆 */
  archive(memoryId: string): void {
    this.db.prepare("UPDATE agent_memories SET is_archived = 1 WHERE id = ?").run(memoryId);
  }

  /** 批量归档低重要度记忆 */
  archiveBatch(agentId: string, userId: string, belowImportance: number): number {
    const result = this.db
      .prepare(
        `UPDATE agent_memories SET is_archived = 1
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0 AND importance < ?`,
      )
      .run(agentId, userId, belowImportance);
    return result.changes;
  }

  /** 清理策略：当活跃记忆超过上限时自动归档 */
  prune(agentId: string, userId: string, maxActive = 1000): number {
    const countResult = this.db
      .prepare<{ count: number }>(
        `SELECT COUNT(*) as count FROM agent_memories
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0`,
      )
      .get(agentId, userId);

    if (!countResult || countResult.count <= maxActive) return 0;

    const excess = countResult.count - maxActive;
    const result = this.db
      .prepare(
        `UPDATE agent_memories SET is_archived = 1
       WHERE id IN (
         SELECT id FROM agent_memories
         WHERE agent_id = ? AND user_id = ? AND is_archived = 0
         ORDER BY importance ASC, last_used ASC
         LIMIT ?
       )`,
      )
      .run(agentId, userId, excess);
    return result.changes;
  }

  /** 按关键词搜索记忆 */
  search(agentId: string, userId: string, keyword: string, limit = 10): readonly MemoryEntry[] {
    const rows = this.db
      .prepare<MemoryRow>(
        `SELECT * FROM agent_memories
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0 AND content LIKE ?
       ORDER BY importance DESC
       LIMIT ?`,
      )
      .all(agentId, userId, `%${keyword}%`, limit);
    return rows.map(rowToEntry);
  }

  /** 列出指定 Agent + User 的所有活跃记忆 */
  listActive(agentId: string, userId: string): readonly MemoryEntry[] {
    const rows = this.db
      .prepare<MemoryRow>(
        `SELECT * FROM agent_memories
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0
       ORDER BY importance DESC`,
      )
      .all(agentId, userId);
    return rows.map(rowToEntry);
  }

  /** 列出指定 User 下所有 Agent 的活跃记忆（用于记忆管理页全量展示） */
  listActiveAllAgents(userId: string): readonly MemoryEntry[] {
    const rows = this.db
      .prepare<MemoryRow>(
        `SELECT * FROM agent_memories
       WHERE user_id = ? AND is_archived = 0
       ORDER BY importance DESC`,
      )
      .all(userId);
    return rows.map(rowToEntry);
  }

  /**
   * 按 ID 永久删除一条记忆（用户在设置页主动删除错误记忆时使用）。
   * 同时删除所有相同 agent_id+user_id+category+content 的重复记录，
   * 确保用户删除后记忆不会因历史重复数据而复现。
   */
  removeById(memoryId: string): void {
    const row = this.db
      .prepare<MemoryRow>("SELECT * FROM agent_memories WHERE id = ?")
      .get(memoryId);
    if (!row) return;
    // 删除所有相同内容的记录（包含历史重复）
    this.db
      .prepare(
        "DELETE FROM agent_memories WHERE agent_id = ? AND user_id = ? AND category = ? AND content = ?",
      )
      .run(row.agent_id, row.user_id, row.category, row.content);
  }

  /**
   * 按 ID 更新单条记忆内容（用户在设置页手动编辑记忆时使用）。
   * 仅更新内容并刷新 last_used，不触碰其他字段。
   */
  updateContentById(memoryId: string, content: string): void {
    this.db
      .prepare("UPDATE agent_memories SET content = ?, last_used = ? WHERE id = ?")
      .run(content, new Date().toISOString(), memoryId);
  }

  /**
   * 清空指定 Agent + User 的全部记忆行
   */
  clearAllForAgent(agentId: string, userId: string): number {
    const result = this.db
      .prepare("DELETE FROM agent_memories WHERE agent_id = ? AND user_id = ?")
      .run(agentId, userId);
    return result.changes ?? 0;
  }
}
