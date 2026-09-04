/**
 * P2: 层间冲突检测器
 *
 * 检测四层配置之间的冲突：
 * - critical：确定且安全的冲突会自动修复
 * - warning：仅记录，不自动修改配置
 *
 * 安全约束：修复不得扩大工具权限，也不得绕过用户批准。
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 */

import { EvolutionLayer } from './types';
import type { Conflict, LayerConfigs, OptimizationObjectives } from './types';

/** 规则迭代上限，防止规则之间循环触发 */
const MAX_RESOLUTION_ITERATIONS = 3;

/** 冲突检测的输入上下文 */
export interface ConflictContext {
  /** 当前四层配置 */
  configs: LayerConfigs;
  /** 最近一次观测到的目标指标（可选） */
  objectives?: Partial<OptimizationObjectives>;
  /** 各层是否启用 */
  enabledLayers?: EvolutionLayer[];
}

/** 冲突规则定义 */
interface ConflictRule {
  id: string;
  severity: 'critical' | 'warning';
  description: string;
  involvedLayers: EvolutionLayer[];
  /** 命中条件 */
  matches(ctx: ConflictContext): boolean;
  /** 仅 critical 规则提供：返回安全的配置修正 */
  fix?(ctx: ConflictContext): Partial<LayerConfigs>;
}

/**
 * 内置冲突规则
 *
 * 规则保持保守：只有能够确定性推导出安全修正的才标记为 critical。
 */
const RULES: ConflictRule[] = [
  {
    id: 'prompt-memory-version-mismatch',
    severity: 'critical',
    description: 'Prompt 变体与记忆排序权重版本不匹配，贡献归因会失真',
    involvedLayers: [EvolutionLayer.PROMPT, EvolutionLayer.MEMORY],
    matches: (ctx) => ctx.configs.promptVariantId !== '' && ctx.configs.memoryWeightsVersion === '',
    // 安全修正：把记忆权重版本回退到基线，不改变 Prompt，也不触碰权限
    fix: () => ({ memoryWeightsVersion: 'baseline' }),
  },
  {
    id: 'skill-tool-strategy-empty',
    severity: 'critical',
    description: '技能策略或工具策略为空，会导致选择器落入未定义分支',
    involvedLayers: [EvolutionLayer.SKILL, EvolutionLayer.TOOL],
    matches: (ctx) => ctx.configs.skillStrategy === '' || ctx.configs.toolStrategy === '',
    // 安全修正：回退到默认策略（等价于 P1 行为，不扩大任何权限）
    fix: (ctx) => {
      const patch: Partial<LayerConfigs> = {};
      if (ctx.configs.skillStrategy === '') patch.skillStrategy = 'default';
      if (ctx.configs.toolStrategy === '') patch.toolStrategy = 'default';
      return patch;
    },
  },
  {
    id: 'cost-quality-tradeoff',
    severity: 'warning',
    description: 'Token 成本偏高但满意度未提升，成本与质量目标可能冲突',
    involvedLayers: [EvolutionLayer.PROMPT, EvolutionLayer.MEMORY],
    matches: (ctx) => {
      const cost = ctx.objectives?.tokenCost;
      const satisfaction = ctx.objectives?.userSatisfaction;
      if (typeof cost !== 'number' || typeof satisfaction !== 'number') return false;
      return cost > 8000 && satisfaction < 0.6;
    },
  },
  {
    id: 'latency-quality-tradeoff',
    severity: 'warning',
    description: '响应时间偏长但满意度未提升，延迟与质量目标可能冲突',
    involvedLayers: [EvolutionLayer.SKILL, EvolutionLayer.TOOL],
    matches: (ctx) => {
      const responseTime = ctx.objectives?.responseTime;
      const satisfaction = ctx.objectives?.userSatisfaction;
      if (typeof responseTime !== 'number' || typeof satisfaction !== 'number') return false;
      return responseTime > 30000 && satisfaction < 0.6;
    },
  },
];

/** 检测结果 */
export interface DetectionResult {
  conflicts: Conflict[];
  criticalCount: number;
  warningCount: number;
}

/** 修复结果 */
export interface ResolutionResult {
  /** 修复后的配置 */
  configs: LayerConfigs;
  /** 已自动修复的 critical 冲突 */
  resolved: Conflict[];
  /** 仅记录、未修复的冲突（含所有 warning 和无法安全修复的 critical） */
  unresolved: Conflict[];
  /** 实际执行的规则迭代次数 */
  iterations: number;
}

/**
 * 层间冲突检测器
 */
export class ConflictDetector {
  private rules: ConflictRule[];

  constructor(rules: ConflictRule[] = RULES) {
    this.rules = rules;
  }

  /**
   * 检测冲突（不修改配置）
   */
  detect(ctx: ConflictContext): DetectionResult {
    const conflicts: Conflict[] = [];

    for (const rule of this.rules) {
      let hit = false;
      try {
        hit = rule.matches(ctx);
      } catch (error) {
        console.warn('[ConflictDetector] Rule evaluation failed', {
          event: 'conflict-rule-error',
          ruleId: rule.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (!hit) continue;

      conflicts.push({
        id: rule.id,
        severity: rule.severity,
        description: rule.description,
        involvedLayers: [...rule.involvedLayers],
        suggestedFix: rule.severity === 'critical' && rule.fix ? rule.fix(ctx) : undefined,
      });
    }

    const criticalCount = conflicts.filter((c) => c.severity === 'critical').length;

    return {
      conflicts,
      criticalCount,
      warningCount: conflicts.length - criticalCount,
    };
  }

  /**
   * 检测并自动修复 critical 冲突
   *
   * warning 只记录不修复；修复后重新校验，最多迭代
   * MAX_RESOLUTION_ITERATIONS 次以防规则循环。
   */
  detectAndResolve(ctx: ConflictContext): ResolutionResult {
    let configs: LayerConfigs = { ...ctx.configs };
    const resolved: Conflict[] = [];
    let iterations = 0;
    let lastDetection = this.detect({ ...ctx, configs });

    while (iterations < MAX_RESOLUTION_ITERATIONS) {
      const fixable = lastDetection.conflicts.filter(
        (c) => c.severity === 'critical' && c.suggestedFix && Object.keys(c.suggestedFix).length > 0
      );

      if (fixable.length === 0) break;

      for (const conflict of fixable) {
        configs = { ...configs, ...conflict.suggestedFix };
        resolved.push(conflict);

        console.info('[ConflictDetector] Critical conflict auto-resolved', {
          event: 'conflict-resolved',
          conflictId: conflict.id,
          involvedLayers: conflict.involvedLayers,
          fix: conflict.suggestedFix,
        });
      }

      iterations += 1;
      // 修复后重新校验
      lastDetection = this.detect({ ...ctx, configs });
    }

    // 最后一次校验仍然命中的冲突都算未解决——即使它曾被"修复"过。
    // 这样规则循环（修复无法消除命中条件）不会被误报成已解决。
    const unresolved = lastDetection.conflicts;

    for (const conflict of unresolved) {
      const level = conflict.severity === 'critical' ? 'error' : 'warn';
      const log = level === 'error' ? console.error : console.warn;
      log('[ConflictDetector] Conflict not auto-resolved', {
        event: 'conflict-unresolved',
        conflictId: conflict.id,
        severity: conflict.severity,
        involvedLayers: conflict.involvedLayers,
      });
    }

    return { configs, resolved, unresolved, iterations };
  }
}
