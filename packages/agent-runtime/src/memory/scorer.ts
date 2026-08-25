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
}

/**
 * 综合打分 = importance * 类别权重 + recency 加分 + relevance 加分。
 * recency 加分随「未使用天数」线性衰减到 0（超过 recencyHalfLifeDays 即无加分）。
 */
export function scoreMemory(input: MemoryScoreInput, cfg: HotMemoryConfig): number {
  const daysSinceUse = (input.now - input.lastUsedAt) / 86_400_000;
  const recencyWeight = cfg.recencyWeight ?? 0.1;
  const recencyHalfLifeDays = cfg.recencyHalfLifeDays ?? 30;
  const recencyBonus = recencyWeight * Math.max(0, 1 - daysSinceUse / recencyHalfLifeDays);
  const relevanceBonus = cfg.relevanceBonus ?? 1.0;

  return (
    input.importance * cfg.categoryWeights[input.category] +
    recencyBonus +
    relevanceBonus * input.relevance
  );
}
