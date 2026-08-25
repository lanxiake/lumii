/**
 * computeTemperature — 记忆温度分档（P0，纯计算不落表）
 *
 * 温度是派生视图：不建列、不迁移，阈值调整立即对全量历史生效。
 * 设计：`docs/design/记忆设计/2026-08-24-memory-design.md` §3.4
 */

import type { MemoryCategory } from "./types.js";
import { isPersonalCategory } from "./types.js";

export type MemoryTemperature = "hot" | "warm" | "cold";

export interface TemperatureInput {
  readonly category: MemoryCategory;
  readonly lastUsedAt: number;
  readonly importance: number;
  readonly now: number;
}

export interface TemperatureThresholds {
  /** hot 判定：N 天内使用过，默认 7 */
  readonly hotRecentDays: number;
  /** warm 判定上限：N 天内未用即降到 cold，默认 30 */
  readonly warmRecentDays: number;
  /** hot 判定：importance >= 此值，默认 0.8 */
  readonly hotImportanceMin: number;
  /** warm 判定：importance >= 此值，默认 0.4 */
  readonly warmImportanceMin: number;
}

export const DEFAULT_TEMPERATURE_THRESHOLDS: TemperatureThresholds = {
  hotRecentDays: 7,
  warmRecentDays: 30,
  hotImportanceMin: 0.8,
  warmImportanceMin: 0.4,
} as const;

/**
 * 分档规则（注意是"或"不是"且"）：
 * - hot：个人类（user/feedback）；或 N 天内用过；或 importance 达标
 * - warm：未超 warmRecentDays 未用，且 importance 达标 warmImportanceMin
 * - cold：其余（超期未用，或 importance 过低且已超 hot 窗口）
 */
export function computeTemperature(
  input: TemperatureInput,
  thresholds: TemperatureThresholds = DEFAULT_TEMPERATURE_THRESHOLDS,
): MemoryTemperature {
  const daysSinceUse = (input.now - input.lastUsedAt) / 86_400_000;

  if (
    isPersonalCategory(input.category) ||
    daysSinceUse <= thresholds.hotRecentDays ||
    input.importance >= thresholds.hotImportanceMin
  ) {
    return "hot";
  }

  if (daysSinceUse <= thresholds.warmRecentDays && input.importance >= thresholds.warmImportanceMin) {
    return "warm";
  }

  return "cold";
}
