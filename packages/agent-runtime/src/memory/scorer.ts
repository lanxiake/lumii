/**
 * scoreMemory — 记忆打分纯函数（从 memory-repo.ts:loadTopMemories 抽取）
 *
 * `now` 显式传入，不依赖 Date.now()，便于固定时间戳单测。
 * 设计：`docs/design/记忆系统/2026-08-24-记忆系统设计.md` §3.3
 *
 * **2026-09-17 自激切断（评审 §2.4.2 / V47）**：本函数不再读任何"活动时间"字段。
 * 此前 recency 加成的输入是 `lastUsedAt`，而它每次注入都被刷新 —— 被注入的条目
 * 因此恒得满分加成、更容易再被注入（实测 9 条吃掉全部注入席位的 54%，单条最高 251 次）。
 * 现在 recency 与年龄衰减**都只按 `createdAt`**（不可变字段），注入行为再也无法
 * 反过来影响自己的分数。切断点在打分公式，不靠"少写一个字段"。
 */

import type { MemoryCategory, HotMemoryConfig } from "./types.js";

/** 打分输入（纯数据，无 DB 依赖） */
export interface MemoryScoreInput {
  /** 当前时间（epoch ms） */
  readonly now: number;
  readonly importance: number;
  readonly category: MemoryCategory;
  /** query 与记忆内容的 overlap 系数，无相关性判定时传 0 */
  readonly relevance: number;
  /**
   * 条目创建时间（epoch ms）。recency 加成与年龄衰减都以此为基准——
   * 用不可变的 `created_at` 而非会被注入刷新的活动时间，是自激被切断的原因。
   */
  readonly createdAt: number;
  /**
   * 计数加成输入。P0 阶段传冻结的 `use_count`（历史曝光量，不再增长）；
   * P1-5 抽样验证效用代理后改传 `utility_count`（评审 §4.3、实施计划 P1-5）。
   */
  readonly useCount?: number;
}

/**
 * 综合打分 = importance × 类别权重 × 年龄衰减 + recency 加分 + relevance 加分 + 计数加成。
 *
 * - 年龄衰减：`max(ageDecayFloor, 0.5^(ageDays / ageDecayHalfLifeDays))`，
 *   温和衰减（默认半衰期 21 天、下限 0.4），保证老的高 importance 条目
 *   不会无条件碾压新条目，但也不会彻底归零。
 * - recency 加分随年龄线性衰减到 0（超过 recencyHalfLifeDays 即无加分）——同以 created_at 计。
 * - 计数加成为对数级并封顶 0.15，避免高频条目霸榜。
 */
export function scoreMemory(input: MemoryScoreInput, cfg: HotMemoryConfig): number {
  const ageDays = Math.max(0, (input.now - input.createdAt) / 86_400_000);

  const recencyWeight = cfg.recencyWeight ?? 0.1;
  const recencyHalfLifeDays = cfg.recencyHalfLifeDays ?? 30;
  const recencyBonus = recencyWeight * Math.max(0, 1 - ageDays / recencyHalfLifeDays);

  const relevanceBonus = cfg.relevanceBonus ?? 1.0;

  const halfLife = cfg.ageDecayHalfLifeDays ?? 21;
  const floor = cfg.ageDecayFloor ?? 0.4;
  const ageFactor = Math.max(floor, 0.5 ** (ageDays / halfLife));

  const useCountWeight = cfg.useCountWeight ?? 0.05;
  const useCountBonus = Math.min(0.15, useCountWeight * Math.log(1 + (input.useCount ?? 0)));

  const base =
    input.importance * cfg.categoryWeights[input.category] * ageFactor + recencyBonus + useCountBonus;

  // 乘法模式：相关性成为**整体缩放因子**，让"完全不相关"的条目被按比例压低，
  // 而不只是少一个加数。
  //
  // **实测结论（2026-09-18，`injection-eval-params.real.test.ts`）**：它并没有更好，
  // 反而略差——「席位→2」时加法 22/25、乘法 20/25。原因在两种模式的量纲差别：
  // 加法是**固定加项**（`+2.0×relevance`），在 base 小的时候相对增益极大
  //（base=0.4 时加 1.0 就是 3.5 倍）；乘法是**比例缩放**，同样的 relevance 只给
  // 2.0 倍。也就是说乘法对相关性的奖励**弱于**加法，把它换上去等于削弱现有的
  // 相关性倾斜。保留这个分支是为了让该判断可复验，默认仍是 additive。
  if (cfg.relevanceMode === "multiplicative") {
    return base * (1 + relevanceBonus * input.relevance);
  }

  return base + relevanceBonus * input.relevance;
}
