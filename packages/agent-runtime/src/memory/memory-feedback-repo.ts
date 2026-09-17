/**
 * MemoryFeedbackRepo — 记忆被「用上」的观测记录（V47 · 评审 §4.3）
 *
 * 职责有两件，缺一不可：
 * 1. 往 `memory_usage_feedback` 写一行隐式反馈（供后续 Learning-to-Rank 训练，
 *    也供人工抽样验证代理有效性——实施计划 P1-5）
 * 2. 递增 `agent_memories.utility_count`（**只记录，不参与打分**）
 *
 * **为什么要有这张表与这两个计数**：V47 之前唯一的"使用"信号是 `use_count`，
 * 而它在**注入时** +1——记的是被展示，不是被使用。实测 9 条记忆吃掉全部注入席位的
 * 54%，其中很大一部分是"注入得越多、越容易被再注入"的自我强化（评审 §2.4.2）。
 *
 * **诚实的局限**：`contribution_score` 由回复文本与记忆正文的 bigram 重叠近似得出，
 * 是一个**代理**而非真值——模型转述记忆时未必复用原词。故 P0 阶段它只入库不进打分，
 * 等抽样验证命中率达标后再启用（实施计划 P1-5）。
 *
 * 表约束（`schema.ts` memory_usage_feedback）：`query_length >= 0`、
 * `was_used_in_response IN (0,1)`、`contribution_score BETWEEN 0 AND 1`、`features NOT NULL`。
 * **不写 query 原文**，只写长度——与 `autonomous/memory-evolution.ts:49` 的既有约定一致。
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { withTransaction } from "../storage/local-database.js";
import { tokenizeForRelevance, overlapCoefficient } from "./segmentation.js";

/**
 * 重叠度分档：≥0.5 视为确实用上，≥0.2 视为可能相关，其余视为未使用。
 *
 * **这两个阈值是暂定的**。`overlapCoefficient` 以 min(|A|,|B|) 为分母，记忆正文通常
 * 远长于回复，导致"回复转述了记忆要点"也只落在 0.2–0.5 的弱相关档（实测样例）。
 * 阈值该定在哪，要靠 P1-5 用真实样本抽样标定——在那之前 `contribution_score`
 * 只入库、不进打分（实施计划约束 #6）。
 */
const CONTRIBUTION_STRONG = 0.5;
const CONTRIBUTION_WEAK = 0.2;

/**
 * 计算「回复在多大程度上用上了这条记忆」。
 *
 * 返回 `{ contributionScore, overlap, keywordMatch }`：
 * - `contributionScore` 三档 0 / 0.5 / 1（表列只接受 0-1 的实数）
 * - `overlap` 是连续的 bigram 重叠系数，作为 `features.semanticSimilarity` 的输入
 * - `keywordMatch` 是共享 token 数
 */
export function computeContribution(
  memoryContent: string,
  replyText: string,
): { contributionScore: number; overlap: number; keywordMatch: number } {
  const memTokens = tokenizeForRelevance(memoryContent);
  const replyTokens = tokenizeForRelevance(replyText);
  if (memTokens.size === 0 || replyTokens.size === 0) {
    return { contributionScore: 0, overlap: 0, keywordMatch: 0 };
  }
  const overlap = overlapCoefficient(memTokens, replyTokens);
  let keywordMatch = 0;
  for (const t of memTokens) if (replyTokens.has(t)) keywordMatch++;
  const contributionScore =
    overlap >= CONTRIBUTION_STRONG ? 1 : overlap >= CONTRIBUTION_WEAK ? 0.5 : 0;
  return { contributionScore, overlap, keywordMatch };
}

/** 一条注入结果（由 MemoryManager 组装后交给本 repo） */
export interface MemoryInjectionOutcome {
  readonly memoryId: string;
  readonly sessionId: string;
  readonly queryLength: number;
  readonly wasUsedInResponse: boolean;
  readonly contributionScore: number;
  /** `MemoryRankingFeatures` 的 12 个字段（不可得的填 0 / false） */
  readonly features: Readonly<Record<string, number | boolean>>;
}

export class MemoryFeedbackRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /**
   * 批量写入反馈并递增 `utility_count`（单事务）。
   *
   * 只有 `contributionScore > 0` 的条目才递增计数——"被注入但没被用上"是负样本，
   * 记进 `memory_usage_feedback`（供训练），但不应抬高该记忆的效用。
   *
   * @returns 实际写入的行数
   */
  recordOutcomes(outcomes: readonly MemoryInjectionOutcome[], now: Date): number {
    if (outcomes.length === 0) return 0;

    const insert = this.db.prepare(
      `INSERT INTO memory_usage_feedback
         (memory_id, session_id, query_length, was_used_in_response,
          contribution_score, user_satisfaction, features, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    );
    const bumpUtility = this.db.prepare(
      "UPDATE agent_memories SET utility_count = utility_count + 1 WHERE id = ?",
    );

    const createdAt = now.toISOString();
    const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

    withTransaction(this.db, () => {
      for (const o of outcomes) {
        insert.run(
          o.memoryId,
          o.sessionId,
          Math.max(0, Math.floor(o.queryLength)),
          o.wasUsedInResponse ? 1 : 0,
          clamp01(o.contributionScore),
          JSON.stringify(o.features),
          createdAt,
        );
        if (o.contributionScore > 0) bumpUtility.run(o.memoryId);
      }
    });

    return outcomes.length;
  }

  /** 统计行数（供「效用数据是否在积累」的健康检查与 P1-5 抽样门槛） */
  countAll(): number {
    return this.db.prepare<{ c: number }>("SELECT COUNT(*) AS c FROM memory_usage_feedback").get()?.c ?? 0;
  }
}
