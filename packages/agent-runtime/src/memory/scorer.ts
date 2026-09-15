/**
 * scoreMemory — 记忆打分纯函数（从 memory-repo.ts:loadTopMemories 抽取）
 *
 * `now` 显式传入，不依赖 Date.now()，便于固定时间戳单测。
 * 设计：`docs/design/记忆设计/2026-08-24-memory-design.md` §3.3
 */

import type { MemoryCategory, HotMemoryConfig } from "./types.js";

/** 打分输入（纯数据，无 DB 依赖） */
export interface MemoryScoreInput {
  /** 当前时间（epoch ms） */
  readonly now: number;
  /** 记忆最后使用时间（epoch ms） */
  readonly lastUsedAt: number;
  readonly importance: number;
  readonly category: MemoryCategory;
  /** query 与记忆内容的 overlap 系数，无相关性判定时传 0 */
  readonly relevance: number;
  /**
   * 条目创建时间（epoch ms）。提供后参与年龄衰减；缺省则不衰减（ageFactor=1）。
   * 用 created_at 而非 last_used 做衰减基准：后者每次注入都被刷新，会让
   * "被注入过的"条目永久保持年轻，形成自激循环。
   */
  readonly createdAt?: number;
  /** 累计使用次数，参与对数级轻微加成。缺省视为 0。 */
  readonly useCount?: number;
}

/**
 * 综合打分 = importance × 类别权重 × 年龄衰减 + recency 加分 + relevance 加分 + use_count 加成。
 *
 * - 年龄衰减：`max(ageDecayFloor, 0.5^(ageDays / ageDecayHalfLifeDays))`，
 *   温和衰减（默认半衰期 21 天、下限 0.4），保证老的高 importance 条目
 *   不会无条件碾压新条目，但也不会彻底归零。
 * - recency 加分随「未使用天数」线性衰减到 0（超过 recencyHalfLifeDays 即无加分）。
 * - use_count 加成为对数级并封顶 0.15，避免高频条目霸榜。
 */
export function scoreMemory(input: MemoryScoreInput, cfg: HotMemoryConfig): number {
  const daysSinceUse = (input.now - input.lastUsedAt) / 86_400_000;
  const recencyWeight = cfg.recencyWeight ?? 0.1;
  const recencyHalfLifeDays = cfg.recencyHalfLifeDays ?? 30;
  const recencyBonus = recencyWeight * Math.max(0, 1 - daysSinceUse / recencyHalfLifeDays);
  const relevanceBonus = cfg.relevanceBonus ?? 1.0;

  let ageFactor = 1;
  if (input.createdAt !== undefined) {
    const halfLife = cfg.ageDecayHalfLifeDays ?? 21;
    const floor = cfg.ageDecayFloor ?? 0.4;
    const ageDays = Math.max(0, (input.now - input.createdAt) / 86_400_000);
    ageFactor = Math.max(floor, 0.5 ** (ageDays / halfLife));
  }

  const useCountWeight = cfg.useCountWeight ?? 0.05;
  const useCountBonus = Math.min(0.15, useCountWeight * Math.log(1 + (input.useCount ?? 0)));

  return (
    input.importance * cfg.categoryWeights[input.category] * ageFactor +
    recencyBonus +
    relevanceBonus * input.relevance +
    useCountBonus
  );
}
