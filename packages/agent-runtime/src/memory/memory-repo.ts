/**
 * AgentMemoryRepo — Agent 记忆 CRUD
 *
 * 基于 SQLite 的 agent_memories 表，提供记忆的加载、保存、归档和搜索。
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { withTransaction } from "../storage/local-database.js";
import type {
  MemoryEntry,
  MemoryRow,
  MemoryCategory,
  HotMemoryConfig,
  MemoryReadScope,
} from "./types.js";
import { DEFAULT_HOT_MEMORY_CONFIG, isPersonalCategory } from "./types.js";
import { tokenizeForRelevance, tokenizeBigram, overlapCoefficient } from "./segmentation.js";
import { scoreMemory } from "./scorer.js";
import { MemoryIndexRepo } from "./memory-index.js";
import {
  MemoryFeedbackRepo,
  type MemoryInjectionOutcome,
} from "./memory-feedback-repo.js";
import {
  computeTemperature,
  DEFAULT_TEMPERATURE_THRESHOLDS,
  type TemperatureThresholds,
} from "./temperature.js";

/** 相关性门控阈值：与当前 query 的 overlap 低于此值的记忆不注入（宁缺毋滥，防上下文污染） */
const RELEVANCE_GATE_THRESHOLD = 0.15;

/**
 * 时间窗候选通道的硬上限（仅防异常数据量的保护性上限，非语义截断）。
 * 近 7 天新建条目一般远低于此值；超出说明有批量导入等异常，取最近的 N 条。
 */
const WINDOW_CANDIDATE_CAP = 500;

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

/**
 * 活动时间（epoch ms）。V47 列，容错回退到 `created_at`。
 *
 * 为什么需要回退：云同步按整行合并，来自旧版本设备的记录不带 `last_injected_at`，
 * 直接 `new Date(null).getTime()` 会得到 NaN，让温度分档的所有比较静默为 false。
 * 测试里手工 INSERT 的行同理。
 */
function activityTimeMs(row: {
  readonly last_injected_at?: string | null;
  readonly created_at: string;
}): number {
  return new Date(row.last_injected_at ?? row.created_at).getTime();
}

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class AgentMemoryRepo {
  private readonly indexRepo: MemoryIndexRepo;
  private readonly feedbackRepo: MemoryFeedbackRepo;

  constructor(private readonly db: DatabaseAdapter) {
    this.indexRepo = new MemoryIndexRepo(db);
    this.feedbackRepo = new MemoryFeedbackRepo(db);
  }

  /** 记录本轮注入的效用观测（V47）：写 memory_usage_feedback + 递增 utility_count */
  recordInjectionOutcomes(
    outcomes: readonly MemoryInjectionOutcome[],
    now: Date = new Date(),
  ): number {
    return this.feedbackRepo.recordOutcomes(outcomes, now);
  }

  /** 已积累的效用反馈条数（P1-5 的抽样门槛、健康检查） */
  countFeedback(): number {
    return this.feedbackRepo.countAll();
  }

  /**
   * 加载热记忆：时间感知的分层席位选取。
   *
   * 选取顺序（总量与 token 预算不变，不增加上下文体积）：
   * 1. **近 24h 席位**（`freshSeats24h`，默认 5）：`created_at` 在 24h 内的条目按 score 占位，
   *    **免 relevance 门控** —— 保证「今天记的当天一定看得见」。
   * 2. **近 7d 席位**（`recentSeats7d`，默认 3）：7 天内新建的剩余条目，同样免门控。
   * 3. **其余席位**：cold 过滤 + 相关性门控后按 score 排序填充。
   *
   * 席位只按 `created_at` 判定、不按 `last_used`：后者每次注入都被刷新，
   * 用作保底会形成「注入过的更容易再被注入」的自激循环。
   *
   * @param query 可选，当前用户消息。提供且有效 token 达门槛时，叠加关键词相关性加分
   *   （overlap 系数），让召回偏向"与当前对话相关"而非仅"重要"。
   * @param scope 读取作用域。`"agent"`（默认）只看本 Agent 的记忆；`"user"` 跨 Agent
   *   读取该用户的全部工作记忆（对应 `AgentDefinition.memory.scope === "user"`）。
   */
  loadTopMemories(
    agentId: string,
    userId: string,
    config: HotMemoryConfig = DEFAULT_HOT_MEMORY_CONFIG,
    query?: string,
    scope: MemoryReadScope = "agent",
  ): readonly MemoryEntry[] {
    const now = Date.now();

    // query 质量门槛：有效 token 达标才启用相关性（用停用词过滤后的 token 判断）
    const minQueryTokens = config.minQueryTokens ?? 2;
    const queryTokens = query ? tokenizeForRelevance(query) : null;
    const useRelevance = !!queryTokens && queryTokens.size >= minQueryTokens;

    // 1. 取候选集（时间窗通道 + importance 预筛通道，合并去重）
    const candidateLimit = useRelevance
      ? Math.max(config.maxItems * 2.5, 200)
      : Math.max(config.maxItems * 2.5, 50);
    const candidates = this.loadCandidates(agentId, userId, scope, candidateLimit, now);

    // 2. 计算 score（含相关性、年龄衰减、计数加成）
    const scored = candidates.map((row) => {
      const relevance = useRelevance
        ? overlapCoefficient(queryTokens, tokenizeForRelevance(row.content))
        : 0;
      const createdAtMs = new Date(row.created_at).getTime();
      const score = scoreMemory(
        {
          now,
          importance: row.importance,
          category: row.category as MemoryCategory,
          relevance,
          createdAt: createdAtMs,
          // 冻结的历史曝光量；P1-5 抽样达标后改为 row.utility_count
          useCount: row.use_count,
        },
        config,
      );
      return { row, score, relevance, createdAtMs };
    });

    // 2.5 按 score 降序 + 按 content 去重（同内容保留 score 最高的一条，消除历史重复影响）
    scored.sort((a, b) => b.score - a.score);
    const seenContent = new Set<string>();
    const deduped = scored.filter(({ row }) => {
      const key = `${row.category}:${row.content}`;
      if (seenContent.has(key)) return false;
      seenContent.add(key);
      return true;
    });

    // 3. 分层席位
    const freshCutoff = now - 24 * 3_600_000;
    const recentCutoff = now - 7 * 86_400_000;
    const freshSeats = Math.max(0, config.freshSeats24h ?? 5);
    const recentSeats = Math.max(0, config.recentSeats7d ?? 3);

    const freshTier = deduped.filter((m) => m.createdAtMs >= freshCutoff);
    // 近 7d 次级席位仍走门控：它只保证"近期且相关"的条目优先于 score 排序占位，
    // 不像 24h 保底席位那样免门控 —— 否则 7 天窗口会把大量无关条目一并注入。
    const recentTier = deduped.filter(
      (m) =>
        m.createdAtMs < freshCutoff &&
        m.createdAtMs >= recentCutoff &&
        this.passesInjectionGates(m, now, config, useRelevance),
    );
    const restTier = deduped.filter(
      (m) =>
        m.createdAtMs < recentCutoff &&
        this.passesInjectionGates(m, now, config, useRelevance),
    );

    const selected: MemoryRow[] = [];
    const takenIds = new Set<string>();
    let tokenSum = 0;

    const tryTake = (m: { readonly row: MemoryRow }): void => {
      if (selected.length >= config.maxItems) return;
      if (takenIds.has(m.row.id)) return;
      // 预算超限时跳过本条而非整体中断：避免一条超长记忆挡掉后面所有保底席位
      const tokens = estimateTokens(m.row.content);
      if (tokenSum + tokens > config.maxTokenBudget && selected.length > 0) return;
      selected.push(m.row);
      takenIds.add(m.row.id);
      tokenSum += tokens;
    };

    const freshQuota = Math.min(freshSeats, config.maxItems);
    for (const m of freshTier) {
      if (selected.length >= freshQuota) break;
      tryTake(m);
    }
    const recentQuota = Math.min(freshSeats + recentSeats, config.maxItems);
    for (const m of recentTier) {
      if (selected.length >= recentQuota) break;
      tryTake(m);
    }
    for (const m of restTier) {
      if (selected.length >= config.maxItems) break;
      tryTake(m);
    }

    // 4. 批量更新活动时间与曝光计数（V47）
    //    `last_used` / `use_count` 已冻结不再写入——它们是打分的上游，被注入刷新即形成自激。
    //    打分公式已改为只按 created_at（scorer.ts），此处记的是**观测**而非**输入**。
    if (selected.length > 0) {
      const nowIso = new Date(now).toISOString();
      const updateStmt = this.db.prepare(
        "UPDATE agent_memories SET last_injected_at = ?, exposure_count = exposure_count + 1 WHERE id = ?",
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
   * 取候选行集：两条通道合并去重。
   *
   * - **时间窗通道**：近 7 天创建的活跃条目全量（有硬上限保护），保证低 importance
   *   的新条目不会被 `ORDER BY importance DESC` 预筛挤出候选之外（席位保底的前提）。
   * - **评分通道**：按 importance 降序的预筛池，供其余席位使用。
   */
  private loadCandidates(
    agentId: string,
    userId: string,
    scope: MemoryReadScope,
    candidateLimit: number,
    now: number,
  ): readonly MemoryRow[] {
    const scopeWhere = scope === "user" ? "" : "agent_id = ? AND ";
    const scopeArgs: readonly string[] = scope === "user" ? [] : [agentId];

    const byId = new Map<string, MemoryRow>();

    const windowStart = new Date(now - 7 * 86_400_000).toISOString();
    const windowRows = this.db
      .prepare<MemoryRow>(
        `SELECT * FROM agent_memories
       WHERE ${scopeWhere}user_id = ? AND is_archived = 0 AND deleted_at IS NULL AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`,
      )
      .all(...scopeArgs, userId, windowStart, WINDOW_CANDIDATE_CAP);
    for (const r of windowRows) byId.set(r.id, r);

    const scoreRows = this.db
      .prepare<MemoryRow>(
        `SELECT * FROM agent_memories
       WHERE ${scopeWhere}user_id = ? AND is_archived = 0 AND deleted_at IS NULL
       ORDER BY importance DESC
       LIMIT ?`,
      )
      .all(...scopeArgs, userId, candidateLimit);
    for (const r of scoreRows) byId.set(r.id, r);

    return [...byId.values()];
  }

  /**
   * 非保底席位的注入门控：冷数据降权 + 温度 cold 丢弃 + 相关性门控。
   *
   * 近 24h 保底席位不走此门控 —— 它的存在意义就是绕过 score 与门控。
   *
   * 无有效 query 且门控开启时**一律不通过**（含画像类），保持 2026-09-13
   * 「相关性无法判断则宁缺毋滥」的语义；此时工作记忆的可见部分仅剩近 24h 保底席位。
   */
  private passesInjectionGates(
    m: { readonly row: MemoryRow; readonly relevance: number },
    now: number,
    config: HotMemoryConfig,
    useRelevance: boolean,
  ): boolean {
    const { row } = m;
    const category = row.category as MemoryCategory;

    // 冷数据降权（只影响注入选取，不改存储数据）：从未被注入且已过期。
    // V47 起按 exposure_count 判定——原先读 use_count（曝光混同使用），
    // 且该列已冻结，继续读会让所有新条目永远落在「从未用过」一侧。
    const skipDays = config.skipUnusedOlderThanDays ?? 30;
    if (skipDays > 0 && row.exposure_count === 0) {
      const ageDays = (now - new Date(row.created_at).getTime()) / 86_400_000;
      if (ageDays > skipDays) return false;
    }

    const temp = computeTemperature(
      {
        category,
        lastInjectedAt: activityTimeMs(row),
        importance: row.importance,
        now,
      },
      DEFAULT_TEMPERATURE_THRESHOLDS,
    );
    // cold → 不注入
    if (temp === "cold") return false;

    // 无有效 query：无法判断相关性，门控开启时宁缺毋滥
    if (!useRelevance) return !(config.gateContextualByRelevance ?? true);
    // 个人类（画像/交互偏好）是 Agent 底层人设，始终注入、不受相关性门控
    if (isPersonalCategory(category)) return true;
    // 显式关闭门控（配置）：相关性仅做加分，不过滤
    if (!(config.gateContextualByRelevance ?? true)) return true;
    // hot / warm 的上下文类记忆一律过相关性门槛
    return m.relevance >= RELEVANCE_GATE_THRESHOLD;
  }

  /**
   * 按时间窗全量枚举记忆（分页，**不叠加条数上限**）。
   *
   * 供「日报 / 周复盘」这类汇总任务取「自上次 daily 以来」「最近 7 天」的全量素材：
   * 低 importance 的当日条目同样可达，不走 top-N 截断、不经相关性门控。
   *
   * @param params.scope `"agent"` 只看本 Agent；`"user"` 跨 Agent 取该用户全部工作记忆
   *   （汇总类 Agent 用后者，否则读不到用户在主 Agent 里积累的工作）。
   * @param params.field 时间字段，默认 `created_at`（条目产生时间）；`last_used` 为活跃时间。
   */
  listByWindow(params: {
    readonly userId: string;
    readonly agentId?: string;
    readonly scope?: MemoryReadScope;
    readonly since: string;
    readonly until?: string;
    readonly field?: "created_at" | "last_used";
    readonly categories?: readonly MemoryCategory[];
    readonly limit?: number;
    readonly offset?: number;
  }): { readonly entries: readonly MemoryEntry[]; readonly total: number; readonly hasMore: boolean } {
    const scope = params.scope ?? "agent";
    const field = params.field ?? "created_at";
    const limit = Math.max(1, Math.min(Math.floor(params.limit ?? 200), 1000));
    const offset = Math.max(0, Math.floor(params.offset ?? 0));

    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (scope !== "user") {
      if (!params.agentId) throw new Error("listByWindow: agentId is required when scope='agent'");
      clauses.push("agent_id = ?");
      args.push(params.agentId);
    }
    clauses.push("user_id = ?", "is_archived = 0 AND deleted_at IS NULL", `${field} >= ?`);
    args.push(params.userId, params.since);
    if (params.until) {
      clauses.push(`${field} <= ?`);
      args.push(params.until);
    }
    if (params.categories && params.categories.length > 0) {
      clauses.push(`category IN (${params.categories.map(() => "?").join(", ")})`);
      args.push(...params.categories);
    }
    const where = clauses.join(" AND ");

    const total =
      this.db
        .prepare<{ count: number }>(`SELECT COUNT(*) AS count FROM agent_memories WHERE ${where}`)
        .get(...args)?.count ?? 0;

    const rows = this.db
      .prepare<MemoryRow>(
        `SELECT * FROM agent_memories
       WHERE ${where}
       ORDER BY ${field} DESC, id ASC
       LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);

    return {
      entries: rows.map(rowToEntry),
      total,
      hasMore: offset + rows.length < total,
    };
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
       WHERE agent_id = ? AND user_id = ? AND category = ? AND content = ? AND is_archived = 0 AND deleted_at IS NULL
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

    const result = this.db
      .prepare(
        `INSERT INTO agent_memories
         (id, agent_id, user_id, category, content, importance, tags,
          source_message_id, source_segment_id, palace_drawer_id,
          created_at, last_used, use_count, is_archived,
          last_injected_at, exposure_count, utility_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0)`,
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
        // 创建时活动时间 = 创建时间：让「距上次使用天数」在从未注入时退化为条目年龄，
        // 与旧 last_used 的行为一致（否则下游的温度分档会拿到 NULL）。
        now,
      );
    this.indexRepo.upsertRow(result.lastInsertRowid, params.content, tagsJson);

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
      last_injected_at: now,
      exposure_count: 0,
      utility_count: 0,
      last_used: now,
      use_count: 0,
      is_archived: false,
    };
  }

  /** 更新记忆重要度 */
  updateImportance(memoryId: string, newImportance: number): void {
    const clamped = Math.max(0, Math.min(1, newImportance));
    this.db
      .prepare("UPDATE agent_memories SET importance = ?, last_injected_at = ? WHERE id = ?")
      .run(clamped, new Date().toISOString(), memoryId);
  }

  /**
   * 合并更新：tags（并集后）+ importance（取高），并刷新活动时间。用于去重合并写入。
   *
   * 刷新 `last_injected_at` 是刻意的：被重新提取到说明这条记忆仍然成立，
   * 属**外生活动**（不由打分驱动），不会构成自激——自激的切断点在打分公式
   * （`scorer.ts` 只按 created_at），不在写入侧少写一个字段。
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
      .prepare("UPDATE agent_memories SET tags = ?, importance = ?, last_injected_at = ? WHERE id = ?")
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

  /** 恢复归档（unarchive） */
  unarchiveById(memoryId: string): void {
    this.db.prepare("UPDATE agent_memories SET is_archived = 0 AND deleted_at IS NULL WHERE id = ?").run(memoryId);
  }

  /**
   * 批量归档冷记忆（last_injected_at > 30 天，且非 user/feedback 画像类）。
   * P0 Task 4：personal 类（user/feedback）不受温度影响，永不自动归档。
   */
  archiveCold(agentId: string, userId: string, now: number, coldDays = 30): number {
    const coldThreshold = new Date(now - coldDays * 86_400_000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE agent_memories SET is_archived = 1
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0 AND deleted_at IS NULL
         AND last_injected_at < ?
         AND category NOT IN ('user', 'feedback')`,
      )
      .run(agentId, userId, coldThreshold);
    return result.changes ?? 0;
  }

  /** 批量归档低重要度记忆 */
  archiveBatch(agentId: string, userId: string, belowImportance: number): number {
    const result = this.db
      .prepare(
        `UPDATE agent_memories SET is_archived = 1
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0 AND deleted_at IS NULL AND importance < ?`,
      )
      .run(agentId, userId, belowImportance);
    return result.changes;
  }

  /** 清理策略：当活跃记忆超过上限时自动归档 */
  prune(agentId: string, userId: string, maxActive = 1000): number {
    const countResult = this.db
      .prepare<{ count: number }>(
        `SELECT COUNT(*) as count FROM agent_memories
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0 AND deleted_at IS NULL`,
      )
      .get(agentId, userId);

    if (!countResult || countResult.count <= maxActive) return 0;

    const excess = countResult.count - maxActive;
    const result = this.db
      .prepare(
        `UPDATE agent_memories SET is_archived = 1
       WHERE id IN (
         SELECT id FROM agent_memories
         WHERE agent_id = ? AND user_id = ? AND is_archived = 0 AND deleted_at IS NULL
         ORDER BY importance ASC, last_injected_at ASC
         LIMIT ?
       )`,
      )
      .run(agentId, userId, excess);
    return result.changes;
  }

  /**
   * 按关键词搜索记忆——FTS5 + BM25 排序（P0）。
   *
   * 查询词与写入时同样按 tokenizeBigram 切分（中文按 bigram，英文/数字按整词），
   * 拼成 OR 短语查询（每个 bigram 各自加引号转义，`"` 转 `""`），
   * 避免用户输入的原始文本被解释为 FTS5 查询语法（AND / OR / 前缀通配 / NEAR 等）。
   * 注意：bm25() 必须引用虚表真实名，不能对 agent_memories_fts 取别名（SQLite 限制）。
   * 分词结果为空（如纯符号/emoji）或 FTS 表缺失（迁移未跑、手动 DROP）时回落 LIKE。
   *
   * @param scope `"agent"`（默认）只搜本 Agent；`"user"` 跨 Agent 搜该用户全部工作记忆
   *   （对应 `AgentDefinition.memory.readView === "user"` 的汇总型 Agent，如 chronicler）。
   *   scope 与注入/列表口径一致，避免同一 Agent 在注入里看得到、在检索里搜不到。
   */
  search(
    agentId: string,
    userId: string,
    keyword: string,
    limit = 10,
    scope: MemoryReadScope = "agent",
  ): readonly MemoryEntry[] {
    const tokens = [...tokenizeBigram(keyword)];
    if (tokens.length === 0) {
      return this.searchByLike(agentId, userId, keyword, limit, scope);
    }
    const scopeWhere = scope === "user" ? "" : "m.agent_id = ? AND ";
    const scopeArgs: readonly string[] = scope === "user" ? [] : [agentId];
    const query = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    try {
      const rows = this.db
        .prepare<MemoryRow>(
          `SELECT m.*
         FROM agent_memories_fts
         JOIN agent_memories m ON m.rowid = agent_memories_fts.rowid
         WHERE agent_memories_fts MATCH ? AND ${scopeWhere}m.user_id = ? AND m.is_archived = 0 AND deleted_at IS NULL
         ORDER BY bm25(agent_memories_fts)
         LIMIT ?`,
        )
        .all(query, ...scopeArgs, userId, limit);
      return rows.map(rowToEntry);
    } catch (err) {
      console.warn("[AgentMemoryRepo.search] FTS5 查询失败，回落 LIKE:", err);
      return this.searchByLike(agentId, userId, keyword, limit, scope);
    }
  }

  private searchByLike(
    agentId: string,
    userId: string,
    keyword: string,
    limit: number,
    scope: MemoryReadScope = "agent",
  ): readonly MemoryEntry[] {
    const scopeWhere = scope === "user" ? "" : "agent_id = ? AND ";
    const scopeArgs: readonly string[] = scope === "user" ? [] : [agentId];
    const rows = this.db
      .prepare<MemoryRow>(
        `SELECT * FROM agent_memories
       WHERE ${scopeWhere}user_id = ? AND is_archived = 0 AND deleted_at IS NULL AND content LIKE ?
       ORDER BY importance DESC
       LIMIT ?`,
      )
      .all(...scopeArgs, userId, `%${keyword}%`, limit);
    return rows.map(rowToEntry);
  }

  /** 列出指定 Agent + User 的所有活跃记忆 */
  listActive(agentId: string, userId: string): readonly MemoryEntry[] {
    const rows = this.db
      .prepare<MemoryRow>(
        `SELECT * FROM agent_memories
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0 AND deleted_at IS NULL
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
       WHERE user_id = ? AND is_archived = 0 AND deleted_at IS NULL
       ORDER BY importance DESC`,
      )
      .all(userId);
    return rows.map(rowToEntry);
  }

  /**
   * 删除一条记忆（用户在设置页主动删掉错误记忆时使用）——**写墓碑，不物理删除**（V38 列，P0-2 补上生产者）。
   *
   * 同时给所有相同 agent_id+user_id+category+content 的历史重复行写墓碑，
   * 确保用户删除后记忆不会因历史重复数据而复现。
   *
   * **为什么改成软删**：`deleted_at` 列自 V38 就为云同步软删除而建，同步器也认它
   * （`sync-importer.ts` 的「优先传播删除」分支）、`asset-checkup` 也认它——
   * 唯独没有生产者，本地删除走的是硬删。结果是删除**无法跨设备传播**：
   * 对端记录仍是活的，下一轮合并会把行带回来。补上生产者，这条链路才闭合。
   *
   * 同时清 `agent_memories_fts` 索引行使其不可检索；主表行保留供审计与同步传播。
   * 读路径全部带 `deleted_at IS NULL`，故已删条目不会再被注入或检索到。
   *
   * 注：`removeByTag`（标签整批轮换）与 `clearAllForAgent`（用户主动清空）**保持硬删**——
   * 前者是临时数据的轮换、后者是用户明示的清空，都不需要墓碑语义。
   */
  removeById(memoryId: string): void {
    const row = this.db
      .prepare<MemoryRow>("SELECT * FROM agent_memories WHERE id = ?")
      .get(memoryId);
    if (!row) return;
    const nowIso = new Date().toISOString();
    // 同内容的历史重复行一并写墓碑，先取 rowid 以同步清理索引
    const dupes = this.db
      .prepare<{ rowid: number }>(
        `SELECT rowid FROM agent_memories
         WHERE agent_id = ? AND user_id = ? AND category = ? AND content = ?
           AND deleted_at IS NULL`,
      )
      .all(row.agent_id, row.user_id, row.category, row.content);
    this.db
      .prepare(
        `UPDATE agent_memories SET deleted_at = ?
         WHERE agent_id = ? AND user_id = ? AND category = ? AND content = ?
           AND deleted_at IS NULL`,
      )
      .run(nowIso, row.agent_id, row.user_id, row.category, row.content);
    this.indexRepo.deleteRows(dupes.map((d) => d.rowid));
  }

  /**
   * 按标签删除某 Agent + User 的记忆行（含 FTS 索引同步），返回删除行数。
   * 用于「同标签整批轮换」场景（如 planner 待办每批替换上一批），
   * 与 removeById 的区别：只删带该标签的行，不按内容牵连其他来源的同文记忆。
   */
  removeByTag(agentId: string, userId: string, tag: string): number {
    const rows = this.db
      .prepare<{ rowid: number; id: string }>(
        "SELECT rowid, id FROM agent_memories WHERE agent_id = ? AND user_id = ? AND tags LIKE ?",
      )
      .all(agentId, userId, `%"${tag}"%`);
    if (rows.length === 0) return 0;
    const del = this.db.prepare("DELETE FROM agent_memories WHERE id = ?");
    for (const row of rows) del.run(row.id);
    this.indexRepo.deleteRows(rows.map((r) => r.rowid));
    return rows.length;
  }

  /**
   * 按 ID 更新单条记忆内容（用户在设置页手动编辑记忆时使用）。
   * 仅更新内容并刷新活动时间，不触碰其他字段。
   */
  updateContentById(memoryId: string, content: string): void {
    const row = this.db
      .prepare<{ rowid: number; tags: string | null }>(
        "SELECT rowid, tags FROM agent_memories WHERE id = ?",
      )
      .get(memoryId);
    if (!row) return;
    this.db
      .prepare("UPDATE agent_memories SET content = ?, last_injected_at = ? WHERE id = ?")
      .run(content, new Date().toISOString(), memoryId);
    this.indexRepo.upsertRow(row.rowid, content, row.tags);
  }

  /**
   * 清空指定 Agent + User 的全部记忆行
   */
  clearAllForAgent(agentId: string, userId: string): number {
    const rowids = this.db
      .prepare<{ rowid: number }>(
        "SELECT rowid FROM agent_memories WHERE agent_id = ? AND user_id = ?",
      )
      .all(agentId, userId);
    const result = this.db
      .prepare("DELETE FROM agent_memories WHERE agent_id = ? AND user_id = ?")
      .run(agentId, userId);
    this.indexRepo.deleteRows(rowids.map((r) => r.rowid));
    return result.changes ?? 0;
  }

  /** 重建 FTS5 派生索引，返回重建后的行数（主表全量条数） */
  rebuildIndex(): number {
    this.indexRepo.rebuildFts();
    const result = this.db
      .prepare<{ c: number }>("SELECT COUNT(*) as c FROM agent_memories")
      .get();
    return result?.c ?? 0;
  }

  /** 按温度（hot/warm/cold）统计活跃记忆分布，供 CLI `memory stats` 与 UI 展示 */
  countByTemperature(
    agentId: string,
    userId: string,
    now: number,
    thresholds: TemperatureThresholds = DEFAULT_TEMPERATURE_THRESHOLDS,
  ): { readonly hot: number; readonly warm: number; readonly cold: number } {
    const rows = this.db
      .prepare<{
        category: string;
        importance: number;
        last_injected_at: string | null;
        created_at: string;
      }>(
        `SELECT category, importance, last_injected_at, created_at FROM agent_memories
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0 AND deleted_at IS NULL`,
      )
      .all(agentId, userId);

    let hot = 0;
    let warm = 0;
    let cold = 0;
    for (const row of rows) {
      const temp = computeTemperature(
        {
          category: row.category as MemoryCategory,
          lastInjectedAt: activityTimeMs(row),
          importance: row.importance,
          now,
        },
        thresholds,
      );
      if (temp === "hot") hot++;
      else if (temp === "warm") warm++;
      else cold++;
    }
    return { hot, warm, cold };
  }
}
