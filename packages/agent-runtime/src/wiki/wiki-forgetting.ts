/**
 * 遗忘曲线排序：新近度 + 使用频次加权，衰减随 use_count 变慢。
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md` §9.2
 * score = recency_weight × 时间衰减 + frequency_weight × log(1 + use_count)
 */

export interface ForgettingScoreInput {
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly useCount: number;
  /** 评估时刻，默认 Date.now() */
  readonly nowMs?: number;
  readonly recencyWeight?: number;
  readonly frequencyWeight?: number;
}

const DEFAULT_RECENCY_WEIGHT = 0.6;
const DEFAULT_FREQUENCY_WEIGHT = 0.4;
/** 基准半衰期（天）：use_count=0 时约 14 天衰减到一半；随 use_count 拉长 */
const BASE_HALF_LIFE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 计算遗忘曲线分数（越高越应排前）。
 * 衰减速率：halfLifeDays = BASE * (1 + log(1+useCount))，用得越多衰减越慢。
 */
export function computeForgettingScore(input: ForgettingScoreInput): number {
  const now = input.nowMs ?? Date.now();
  const recencyW = input.recencyWeight ?? DEFAULT_RECENCY_WEIGHT;
  const freqW = input.frequencyWeight ?? DEFAULT_FREQUENCY_WEIGHT;
  const useCount = Math.max(0, input.useCount);

  const anchorIso = input.lastUsedAt ?? input.createdAt;
  const anchorMs = new Date(anchorIso).getTime();
  const ageDays = Number.isNaN(anchorMs) ? 365 : Math.max(0, (now - anchorMs) / MS_PER_DAY);

  const halfLife = BASE_HALF_LIFE_DAYS * (1 + Math.log1p(useCount));
  const decay = Math.pow(0.5, ageDays / halfLife);
  const frequency = Math.log1p(useCount);

  return recencyW * decay + freqW * frequency;
}

/**
 * 按遗忘分数降序排序（稳定：同分保持相对顺序）。
 */
export function rankByForgettingScore<T extends ForgettingScoreInput>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, score: computeForgettingScore(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}
