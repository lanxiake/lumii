/**
 * P2: Shapley Value 贡献归因
 *
 * 将一次会话的满意度分解为四层（Prompt / Memory / Skill / Tool）的贡献
 * 默认使用边际贡献近似；样本充足时支持受预算约束的完整 Shapley 估计
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 */

import { EvolutionLayer } from './types';
import type { LayerContribution } from './types';
import { SHAPLEY_MAX_COMBINATIONS } from './config';

/** 参与归因的四个层（顺序固定，保证结果可复现） */
export const ATTRIBUTION_LAYERS: EvolutionLayer[] = [
  EvolutionLayer.PROMPT,
  EvolutionLayer.MEMORY,
  EvolutionLayer.SKILL,
  EvolutionLayer.TOOL,
];

/**
 * 一次会话的层级观测值
 * 每层给出一个 [0, 1] 的效果得分（缺失时为 undefined）
 */
export interface LayerObservation {
  layer: EvolutionLayer;
  /** 该层本次会话的效果得分 (0-1)，缺失表示该层未参与 */
  score?: number;
  /** 该层的样本量，用于置信度加权 */
  sampleCount: number;
}

/** 均匀分配的贡献（无有效观测时的兜底） */
export function uniformContribution(): LayerContribution {
  const share = 1 / ATTRIBUTION_LAYERS.length;
  return { prompt: share, memory: share, skill: share, tool: share };
}

/**
 * 边际贡献近似（默认路径）
 *
 * 每层贡献 = 该层得分相对基线（各层平均分）的增量，截断负值后归一化。
 * 当所有层都等于基线时退化为均匀分配。
 */
export function computeMarginalContribution(observations: LayerObservation[]): LayerContribution {
  const valid = observations.filter(
    (o) => typeof o.score === 'number' && Number.isFinite(o.score) && o.score >= 0 && o.score <= 1
  );

  if (valid.length === 0) {
    return uniformContribution();
  }

  // 基线为各有效层的平均得分
  const baseline = valid.reduce((sum, o) => sum + (o.score as number), 0) / valid.length;

  // 边际增量，负贡献截断为 0（负贡献不参与正向归因）
  const raw = new Map<EvolutionLayer, number>();
  for (const layer of ATTRIBUTION_LAYERS) {
    const obs = valid.find((o) => o.layer === layer);
    if (!obs) {
      raw.set(layer, 0);
      continue;
    }
    raw.set(layer, Math.max(0, (obs.score as number) - baseline));
  }

  return normalizeContribution(raw, valid.map((o) => o.layer));
}

/**
 * 完整 Shapley 估计（受组合预算约束）
 *
 * @param valueFn 特征函数：给定一个层的子集，返回该组合的效果得分 (0-1)
 * @param maxCombinations 组合数上限，超出时回退到边际近似
 */
export function computeShapleyContribution(
  valueFn: (subset: EvolutionLayer[]) => number,
  observations: LayerObservation[],
  maxCombinations: number = SHAPLEY_MAX_COMBINATIONS
): LayerContribution {
  const layers = ATTRIBUTION_LAYERS;
  const subsetCount = 2 ** layers.length; // 16

  // 超出计算预算时回退到近似路径
  if (subsetCount > maxCombinations) {
    return computeMarginalContribution(observations);
  }

  const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));
  const n = layers.length;
  const raw = new Map<EvolutionLayer, number>();

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    let shapley = 0;

    // 枚举不含该层的所有子集 S，累加加权边际贡献 v(S ∪ {i}) - v(S)
    for (let mask = 0; mask < subsetCount; mask++) {
      if (mask & (1 << i)) continue; // 跳过含该层的子集

      const subset = layers.filter((_, j) => Boolean(mask & (1 << j)));
      const withLayer = [...subset, layer];

      const marginal = safeValue(valueFn, withLayer) - safeValue(valueFn, subset);
      const s = subset.length;
      const weight = (factorial(s) * factorial(n - s - 1)) / factorial(n);

      shapley += weight * marginal;
    }

    // 负贡献截断
    raw.set(layer, Math.max(0, shapley));
  }

  return normalizeContribution(raw, layers);
}

/** 调用特征函数并对异常/越界返回做兜底 */
function safeValue(valueFn: (subset: EvolutionLayer[]) => number, subset: EvolutionLayer[]): number {
  try {
    const v = valueFn(subset);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
  } catch {
    return 0;
  }
}

/**
 * 归一化贡献，使总和为 1
 * 全零时在参与层之间均匀分配
 */
function normalizeContribution(raw: Map<EvolutionLayer, number>, participatingLayers: EvolutionLayer[]): LayerContribution {
  const total = Array.from(raw.values()).reduce((sum, v) => sum + v, 0);

  if (total <= 0) {
    // 无正向差异：在实际参与的层之间均匀分配
    const layers = participatingLayers.length > 0 ? participatingLayers : ATTRIBUTION_LAYERS;
    const share = 1 / layers.length;
    const result: LayerContribution = { prompt: 0, memory: 0, skill: 0, tool: 0 };
    for (const layer of layers) {
      result[layerKey(layer)] = share;
    }
    return result;
  }

  return {
    prompt: (raw.get(EvolutionLayer.PROMPT) ?? 0) / total,
    memory: (raw.get(EvolutionLayer.MEMORY) ?? 0) / total,
    skill: (raw.get(EvolutionLayer.SKILL) ?? 0) / total,
    tool: (raw.get(EvolutionLayer.TOOL) ?? 0) / total,
  };
}

/** 将 EvolutionLayer 映射为 LayerContribution 的键 */
function layerKey(layer: EvolutionLayer): keyof LayerContribution {
  switch (layer) {
    case EvolutionLayer.PROMPT:
      return 'prompt';
    case EvolutionLayer.MEMORY:
      return 'memory';
    case EvolutionLayer.SKILL:
      return 'skill';
    case EvolutionLayer.TOOL:
      return 'tool';
  }
}

/** 贡献度总和是否接近 1（用于自检和告警） */
export function isContributionNormalized(contribution: LayerContribution, tolerance: number = 1e-6): boolean {
  const sum = contribution.prompt + contribution.memory + contribution.skill + contribution.tool;
  return Math.abs(sum - 1) <= tolerance;
}
