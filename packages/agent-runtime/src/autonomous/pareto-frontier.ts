/**
 * P2: 帕累托前沿维护（多目标优化）
 *
 * 四个目标及其方向：
 * - userSatisfaction  越大越好
 * - responseTime      越小越好
 * - tokenCost         越小越好
 * - consistencyScore  越大越好
 *
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 */

import type { LayerConfigs, OptimizationObjectives, ParetoConfig, ParetoPreference } from './types';
import { PARETO_FRONTIER_MAX_SIZE } from './config';

/** 目标方向：'max' 表示越大越好，'min' 表示越小越好 */
export const OBJECTIVE_DIRECTIONS: Record<keyof OptimizationObjectives, 'max' | 'min'> = {
  userSatisfaction: 'max',
  responseTime: 'min',
  tokenCost: 'min',
  consistencyScore: 'max',
};

/** 归一化上界，用于把 min 类目标映射到 [0,1] */
const RESPONSE_TIME_CAP_MS = 60000;
const TOKEN_COST_CAP = 20000;

/**
 * a 是否支配 b
 *
 * 支配定义：a 在所有目标上都不差于 b，且至少在一个目标上严格优于 b。
 */
export function dominates(a: OptimizationObjectives, b: OptimizationObjectives): boolean {
  let strictlyBetter = false;

  for (const key of Object.keys(OBJECTIVE_DIRECTIONS) as Array<keyof OptimizationObjectives>) {
    const direction = OBJECTIVE_DIRECTIONS[key];
    const av = a[key];
    const bv = b[key];

    if (!Number.isFinite(av) || !Number.isFinite(bv)) {
      // 指标缺失或异常时不做支配判断，保守返回 false
      return false;
    }

    if (direction === 'max') {
      if (av < bv) return false;
      if (av > bv) strictlyBetter = true;
    } else {
      if (av > bv) return false;
      if (av < bv) strictlyBetter = true;
    }
  }

  return strictlyBetter;
}

/** 计算配置的哈希（确定性，用于去重） */
export function computeConfigHash(config: LayerConfigs): string {
  const canonical = [
    config.promptVariantId,
    config.memoryWeightsVersion,
    config.skillStrategy,
    config.toolStrategy,
  ].join('|');

  // FNV-1a 32 位哈希，确定性且无外部依赖
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 把目标向量归一化为 [0,1]，方向统一为"越大越好" */
function normalizeObjectives(o: OptimizationObjectives): Record<keyof OptimizationObjectives, number> {
  return {
    userSatisfaction: clamp01(o.userSatisfaction),
    consistencyScore: clamp01(o.consistencyScore),
    responseTime: 1 - clamp01(o.responseTime / RESPONSE_TIME_CAP_MS),
    tokenCost: 1 - clamp01(o.tokenCost / TOKEN_COST_CAP),
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** 不同偏好下的目标权重 */
const PREFERENCE_WEIGHTS: Record<ParetoPreference, Record<keyof OptimizationObjectives, number>> = {
  satisfaction: { userSatisfaction: 0.7, consistencyScore: 0.2, responseTime: 0.05, tokenCost: 0.05 },
  speed: { userSatisfaction: 0.2, consistencyScore: 0.1, responseTime: 0.6, tokenCost: 0.1 },
  cost: { userSatisfaction: 0.2, consistencyScore: 0.1, responseTime: 0.1, tokenCost: 0.6 },
  balanced: { userSatisfaction: 0.4, consistencyScore: 0.2, responseTime: 0.2, tokenCost: 0.2 },
};

/**
 * 帕累托前沿
 */
export class ParetoFrontier {
  private configs: Map<string, ParetoConfig>;
  private maxSize: number;

  constructor(maxSize: number = PARETO_FRONTIER_MAX_SIZE) {
    this.configs = new Map();
    this.maxSize = maxSize;
  }

  /**
   * 尝试加入一个配置
   *
   * @returns 是否被加入前沿（被支配则不加入）
   */
  add(config: LayerConfigs, objectives: OptimizationObjectives, timestamp: string = new Date().toISOString()): boolean {
    const configHash = computeConfigHash(config);

    // 相同配置：更新指标和使用次数，不改变前沿结构
    const existing = this.configs.get(configHash);
    if (existing) {
      existing.usageCount += 1;
      existing.objectives = objectives;
      return true;
    }

    // 被前沿中任一配置支配则拒绝加入
    for (const entry of this.configs.values()) {
      if (dominates(entry.objectives, objectives)) {
        return false;
      }
    }

    // 移除被新配置支配的旧配置
    for (const [hash, entry] of Array.from(this.configs.entries())) {
      if (dominates(objectives, entry.objectives)) {
        this.configs.delete(hash);
      }
    }

    this.configs.set(configHash, {
      id: configHash,
      configHash,
      config: { ...config },
      objectives,
      usageCount: 1,
      addedAt: timestamp,
    });

    this.enforceCapacity();
    return true;
  }

  /**
   * 容量上限控制
   *
   * 采用确定性淘汰策略：balanced 加权得分最低者先淘汰；
   * 得分相同时淘汰更早加入的配置。
   */
  private enforceCapacity(): void {
    if (this.configs.size <= this.maxSize) return;

    const ranked = Array.from(this.configs.values()).sort((a, b) => {
      const scoreA = this.weightedScore(a.objectives, 'balanced');
      const scoreB = this.weightedScore(b.objectives, 'balanced');
      if (scoreA !== scoreB) return scoreA - scoreB;
      return a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : a.configHash < b.configHash ? -1 : 1;
    });

    const removeCount = this.configs.size - this.maxSize;
    for (let i = 0; i < removeCount; i++) {
      this.configs.delete(ranked[i].configHash);
    }
  }

  /** 计算加权得分 */
  private weightedScore(objectives: OptimizationObjectives, preference: ParetoPreference): number {
    const normalized = normalizeObjectives(objectives);
    const weights = PREFERENCE_WEIGHTS[preference];

    return (
      normalized.userSatisfaction * weights.userSatisfaction +
      normalized.consistencyScore * weights.consistencyScore +
      normalized.responseTime * weights.responseTime +
      normalized.tokenCost * weights.tokenCost
    );
  }

  /**
   * 按偏好选择最优配置
   *
   * @returns 前沿为空时返回 null
   */
  select(preference: ParetoPreference = 'balanced'): ParetoConfig | null {
    if (this.configs.size === 0) return null;

    let best: ParetoConfig | null = null;
    let bestScore = -Infinity;

    // 遍历顺序按 hash 排序，保证结果确定性
    const sorted = Array.from(this.configs.values()).sort((a, b) => (a.configHash < b.configHash ? -1 : 1));

    for (const entry of sorted) {
      const score = this.weightedScore(entry.objectives, preference);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }

    return best;
  }

  /** 获取全部前沿配置 */
  getAll(): ParetoConfig[] {
    return Array.from(this.configs.values()).map((c) => ({ ...c, config: { ...c.config } }));
  }

  /** 前沿大小 */
  size(): number {
    return this.configs.size;
  }

  /** 加载前沿（用于持久化恢复），加载时重新过滤被支配项 */
  load(entries: ParetoConfig[]): void {
    this.configs.clear();
    for (const entry of entries) {
      const dominated = entries.some((other) => other.configHash !== entry.configHash && dominates(other.objectives, entry.objectives));
      if (!dominated) {
        this.configs.set(entry.configHash, { ...entry, config: { ...entry.config } });
      }
    }
    this.enforceCapacity();
  }

  /** 清空前沿 */
  clear(): void {
    this.configs.clear();
  }
}
