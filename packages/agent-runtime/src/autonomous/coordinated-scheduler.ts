/**
 * P2: 协同探索调度器
 *
 * 职责：
 * - 根据全局满意度计算探索预算
 * - 保证一次会话最多探索一层（避免归因失真）
 * - 使用 EMA 更新层级优先级，维护最近探索历史
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 */

import { EvolutionLayer, ExplorationMode } from './types';
import type { SchedulerState, LayerContribution } from './types';
import {
  EXPLORATION_BUDGET_BASE,
  EXPLORATION_BUDGET_MAX,
  LAYER_PRIORITY_EMA_ALPHA,
  SATISFACTION_THRESHOLD,
} from './config';
import { ATTRIBUTION_LAYERS } from './shapley-attribution';

/** 最近探索历史保留条数 */
const RECENT_EXPLORATION_LIMIT = 20;

/** 调度决策（可解释） */
export interface SchedulingDecision {
  /** 探索模式 */
  mode: ExplorationMode;
  /** 被探索的层（利用模式下为 null） */
  layer: EvolutionLayer | null;
  /** 决策原因（用于审计和可观测性） */
  reason: string;
  /** 当次探索预算 */
  explorationBudget: number;
}

/** 随机源（便于测试注入确定性序列） */
export type RandomSource = () => number;

/** 层 → ExplorationMode 映射 */
const LAYER_TO_MODE: Record<EvolutionLayer, ExplorationMode> = {
  [EvolutionLayer.PROMPT]: ExplorationMode.EXPLORE_PROMPT,
  [EvolutionLayer.MEMORY]: ExplorationMode.EXPLORE_MEMORY,
  [EvolutionLayer.SKILL]: ExplorationMode.EXPLORE_SKILL,
  [EvolutionLayer.TOOL]: ExplorationMode.EXPLORE_TOOL,
};

/**
 * 根据全局满意度计算探索预算
 *
 * 满意度高 → 少探索（保住当前收益）；满意度低 → 多探索（寻找改进）
 * 结果限制在 [EXPLORATION_BUDGET_BASE, EXPLORATION_BUDGET_MAX]
 */
export function computeExplorationBudget(globalSatisfaction: number): number {
  // 非有限输入（NaN/Infinity）无法裁剪，按基准预算保守处理
  if (!Number.isFinite(globalSatisfaction)) {
    return EXPLORATION_BUDGET_BASE;
  }

  const satisfaction = Math.max(0, Math.min(1, globalSatisfaction));

  if (satisfaction >= SATISFACTION_THRESHOLD) {
    return EXPLORATION_BUDGET_BASE;
  }

  // 满意度从阈值线性下降到 0 时，预算从 BASE 线性升到 MAX
  const deficit = (SATISFACTION_THRESHOLD - satisfaction) / SATISFACTION_THRESHOLD;
  const budget = EXPLORATION_BUDGET_BASE + deficit * (EXPLORATION_BUDGET_MAX - EXPLORATION_BUDGET_BASE);

  return Math.max(EXPLORATION_BUDGET_BASE, Math.min(EXPLORATION_BUDGET_MAX, budget));
}

/** 创建初始调度状态 */
export function createInitialSchedulerState(): SchedulerState {
  const priorities = {} as Record<EvolutionLayer, number>;
  for (const layer of ATTRIBUTION_LAYERS) {
    priorities[layer] = 1 / ATTRIBUTION_LAYERS.length;
  }

  return {
    globalSatisfaction: SATISFACTION_THRESHOLD,
    explorationBudget: EXPLORATION_BUDGET_BASE,
    recentExplorations: [],
    layerPriorities: priorities,
  };
}

/**
 * 协同探索调度器
 */
export class CoordinatedScheduler {
  private state: SchedulerState;
  private random: RandomSource;
  /** 各层是否启用（支持独立关闭并回退到 P0/P1 策略） */
  private enabledLayers: Set<EvolutionLayer>;

  constructor(options?: {
    state?: SchedulerState;
    random?: RandomSource;
    enabledLayers?: EvolutionLayer[];
  }) {
    this.state = options?.state ?? createInitialSchedulerState();
    this.random = options?.random ?? Math.random;
    this.enabledLayers = new Set(options?.enabledLayers ?? ATTRIBUTION_LAYERS);
  }

  /**
   * 决定本次会话的探索策略
   *
   * 一次会话最多探索一层：先按预算决定是否探索，再选择优先级最高、
   * 且最近未被探索过的层。
   */
  decide(): SchedulingDecision {
    const budget = computeExplorationBudget(this.state.globalSatisfaction);
    this.state.explorationBudget = budget;

    const candidates = ATTRIBUTION_LAYERS.filter((l) => this.enabledLayers.has(l));

    if (candidates.length === 0) {
      return {
        mode: ExplorationMode.EXPLOIT,
        layer: null,
        reason: 'all P2 layers disabled, falling back to exploitation',
        explorationBudget: budget,
      };
    }

    const roll = this.random();
    if (roll >= budget) {
      return {
        mode: ExplorationMode.EXPLOIT,
        layer: null,
        reason: `roll ${roll.toFixed(3)} >= budget ${budget.toFixed(3)}, exploiting best known config`,
        explorationBudget: budget,
      };
    }

    const layer = this.selectLayerToExplore(candidates);

    return {
      mode: LAYER_TO_MODE[layer],
      layer,
      reason: `roll ${roll.toFixed(3)} < budget ${budget.toFixed(3)}; selected layer '${layer}' (priority ${this.state.layerPriorities[layer]?.toFixed(3) ?? 'n/a'}, least recently explored)`,
      explorationBudget: budget,
    };
  }

  /**
   * 选择要探索的层
   *
   * 优先探索从未探索过的层；其余情况按 优先级 / 探索次数 轮流，
   * 保证低优先级层也能得到探索机会。
   */
  private selectLayerToExplore(candidates: EvolutionLayer[]): EvolutionLayer {
    const explorationCounts = new Map<EvolutionLayer, number>();
    for (const layer of candidates) {
      explorationCounts.set(layer, 0);
    }
    for (const record of this.state.recentExplorations) {
      if (explorationCounts.has(record.layer)) {
        explorationCounts.set(record.layer, (explorationCounts.get(record.layer) ?? 0) + 1);
      }
    }

    // 从未探索过的层优先
    const unexplored = candidates.filter((l) => (explorationCounts.get(l) ?? 0) === 0);
    if (unexplored.length > 0) {
      return unexplored.reduce((best, l) =>
        (this.state.layerPriorities[l] ?? 0) > (this.state.layerPriorities[best] ?? 0) ? l : best
      );
    }

    // 否则按 优先级 / (探索次数 + 1) 排序，兼顾优先级与公平性
    return candidates.reduce((best, l) => {
      const scoreL = (this.state.layerPriorities[l] ?? 0) / ((explorationCounts.get(l) ?? 0) + 1);
      const scoreBest = (this.state.layerPriorities[best] ?? 0) / ((explorationCounts.get(best) ?? 0) + 1);
      return scoreL > scoreBest ? l : best;
    });
  }

  /**
   * 记录一次探索结果，并用 EMA 更新层级优先级
   */
  recordExploration(layer: EvolutionLayer, satisfactionAfter: number, timestamp: string = new Date().toISOString()): void {
    const satisfaction = Math.max(0, Math.min(1, satisfactionAfter));

    this.state.recentExplorations.push({ layer, timestamp, satisfactionAfter: satisfaction });

    // 限制历史长度
    if (this.state.recentExplorations.length > RECENT_EXPLORATION_LIMIT) {
      this.state.recentExplorations = this.state.recentExplorations.slice(-RECENT_EXPLORATION_LIMIT);
    }

    // EMA 更新该层优先级：探索后满意度越高，越值得继续投入
    const current = this.state.layerPriorities[layer] ?? 1 / ATTRIBUTION_LAYERS.length;
    this.state.layerPriorities[layer] = current * (1 - LAYER_PRIORITY_EMA_ALPHA) + satisfaction * LAYER_PRIORITY_EMA_ALPHA;
  }

  /**
   * 用贡献归因结果更新各层优先级（EMA）
   */
  updatePrioritiesFromContribution(contribution: LayerContribution): void {
    const pairs: Array<[EvolutionLayer, number]> = [
      [EvolutionLayer.PROMPT, contribution.prompt],
      [EvolutionLayer.MEMORY, contribution.memory],
      [EvolutionLayer.SKILL, contribution.skill],
      [EvolutionLayer.TOOL, contribution.tool],
    ];

    for (const [layer, value] of pairs) {
      if (!Number.isFinite(value)) continue;
      const current = this.state.layerPriorities[layer] ?? 1 / ATTRIBUTION_LAYERS.length;
      this.state.layerPriorities[layer] = current * (1 - LAYER_PRIORITY_EMA_ALPHA) + Math.max(0, Math.min(1, value)) * LAYER_PRIORITY_EMA_ALPHA;
    }
  }

  /** 更新全局满意度（EMA） */
  updateGlobalSatisfaction(satisfaction: number): void {
    if (!Number.isFinite(satisfaction)) return;
    const clamped = Math.max(0, Math.min(1, satisfaction));
    this.state.globalSatisfaction =
      this.state.globalSatisfaction * (1 - LAYER_PRIORITY_EMA_ALPHA) + clamped * LAYER_PRIORITY_EMA_ALPHA;
  }

  /** 获取状态快照（用于持久化） */
  getState(): SchedulerState {
    return {
      globalSatisfaction: this.state.globalSatisfaction,
      explorationBudget: this.state.explorationBudget,
      recentExplorations: this.state.recentExplorations.map((r) => ({ ...r })),
      layerPriorities: { ...this.state.layerPriorities },
    };
  }

  /** 从快照恢复状态 */
  restoreState(state: SchedulerState): void {
    this.state = {
      globalSatisfaction: state.globalSatisfaction,
      explorationBudget: state.explorationBudget,
      recentExplorations: state.recentExplorations.map((r) => ({ ...r })),
      layerPriorities: { ...state.layerPriorities },
    };
  }

  /** 启用/禁用某层的探索 */
  setLayerEnabled(layer: EvolutionLayer, enabled: boolean): void {
    if (enabled) {
      this.enabledLayers.add(layer);
    } else {
      this.enabledLayers.delete(layer);
    }
  }
}
