/**
 * P2: 层间冲突检测与修复测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictDetector } from '../conflict-detector';
import { EvolutionLayer } from '../types';
import type { LayerConfigs } from '../types';

/** 健康的四层配置 */
function healthyConfigs(overrides: Partial<LayerConfigs> = {}): LayerConfigs {
  return {
    promptVariantId: 'variant-1',
    memoryWeightsVersion: 'v3',
    skillStrategy: 'balanced',
    toolStrategy: 'thompson',
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detect 冲突检测', () => {
  it('健康配置不产生冲突', () => {
    const detector = new ConflictDetector();
    const result = detector.detect({ configs: healthyConfigs() });

    expect(result.conflicts).toHaveLength(0);
    expect(result.criticalCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it('记忆权重版本缺失被判定为 critical', () => {
    const detector = new ConflictDetector();
    const result = detector.detect({ configs: healthyConfigs({ memoryWeightsVersion: '' }) });

    const conflict = result.conflicts.find((c) => c.id === 'prompt-memory-version-mismatch');
    expect(conflict).toBeDefined();
    expect(conflict!.severity).toBe('critical');
    expect(conflict!.involvedLayers).toEqual([EvolutionLayer.PROMPT, EvolutionLayer.MEMORY]);
    expect(conflict!.suggestedFix).toBeDefined();
  });

  it('技能或工具策略为空被判定为 critical', () => {
    const detector = new ConflictDetector();

    const skillEmpty = detector.detect({ configs: healthyConfigs({ skillStrategy: '' }) });
    expect(skillEmpty.conflicts.some((c) => c.id === 'skill-tool-strategy-empty')).toBe(true);

    const toolEmpty = detector.detect({ configs: healthyConfigs({ toolStrategy: '' }) });
    expect(toolEmpty.conflicts.some((c) => c.id === 'skill-tool-strategy-empty')).toBe(true);
  });

  it('高成本低满意度被判定为 warning', () => {
    const detector = new ConflictDetector();
    const result = detector.detect({
      configs: healthyConfigs(),
      objectives: { tokenCost: 12000, userSatisfaction: 0.4 },
    });

    const conflict = result.conflicts.find((c) => c.id === 'cost-quality-tradeoff');
    expect(conflict).toBeDefined();
    expect(conflict!.severity).toBe('warning');
    // warning 不提供自动修复
    expect(conflict!.suggestedFix).toBeUndefined();
  });

  it('高延迟低满意度被判定为 warning', () => {
    const detector = new ConflictDetector();
    const result = detector.detect({
      configs: healthyConfigs(),
      objectives: { responseTime: 45000, userSatisfaction: 0.3 },
    });

    expect(result.conflicts.some((c) => c.id === 'latency-quality-tradeoff')).toBe(true);
    expect(result.warningCount).toBeGreaterThan(0);
  });

  it('指标缺失时成本/延迟规则不命中', () => {
    const detector = new ConflictDetector();
    const result = detector.detect({ configs: healthyConfigs(), objectives: {} });

    expect(result.conflicts.some((c) => c.id === 'cost-quality-tradeoff')).toBe(false);
    expect(result.conflicts.some((c) => c.id === 'latency-quality-tradeoff')).toBe(false);
  });

  it('高成本但满意度也高时不算冲突', () => {
    const detector = new ConflictDetector();
    const result = detector.detect({
      configs: healthyConfigs(),
      objectives: { tokenCost: 15000, userSatisfaction: 0.9 },
    });

    expect(result.conflicts.some((c) => c.id === 'cost-quality-tradeoff')).toBe(false);
  });

  it('critical 与 warning 计数正确分开统计', () => {
    const detector = new ConflictDetector();
    const result = detector.detect({
      configs: healthyConfigs({ skillStrategy: '' }),
      objectives: { tokenCost: 12000, userSatisfaction: 0.4 },
    });

    expect(result.criticalCount).toBe(1);
    expect(result.warningCount).toBe(1);
    expect(result.conflicts).toHaveLength(2);
  });

  it('detect 不修改传入的配置', () => {
    const detector = new ConflictDetector();
    const configs = healthyConfigs({ memoryWeightsVersion: '' });

    detector.detect({ configs });

    expect(configs.memoryWeightsVersion).toBe('');
  });

  it('规则抛错时被跳过，不影响其他规则', () => {
    const detector = new ConflictDetector([
      {
        id: 'boom',
        severity: 'critical',
        description: 'always throws',
        involvedLayers: [EvolutionLayer.PROMPT],
        matches: () => {
          throw new Error('rule failure');
        },
      },
      {
        id: 'ok',
        severity: 'warning',
        description: 'always matches',
        involvedLayers: [EvolutionLayer.TOOL],
        matches: () => true,
      },
    ] as any);

    const result = detector.detect({ configs: healthyConfigs() });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].id).toBe('ok');
  });
});

describe('detectAndResolve 自动修复', () => {
  it('critical 冲突被自动安全修复', () => {
    const detector = new ConflictDetector();
    const result = detector.detectAndResolve({ configs: healthyConfigs({ memoryWeightsVersion: '' }) });

    expect(result.resolved.map((c) => c.id)).toContain('prompt-memory-version-mismatch');
    expect(result.configs.memoryWeightsVersion).toBe('baseline');
  });

  it('空策略被回退到 default', () => {
    const detector = new ConflictDetector();
    const result = detector.detectAndResolve({
      configs: healthyConfigs({ skillStrategy: '', toolStrategy: '' }),
    });

    expect(result.configs.skillStrategy).toBe('default');
    expect(result.configs.toolStrategy).toBe('default');
  });

  it('warning 只记录不修复配置', () => {
    const detector = new ConflictDetector();
    const configs = healthyConfigs();
    const result = detector.detectAndResolve({
      configs,
      objectives: { tokenCost: 12000, userSatisfaction: 0.4 },
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved.some((c) => c.id === 'cost-quality-tradeoff')).toBe(true);
    expect(result.configs).toEqual(configs);
  });

  it('修复后重新校验，最终不再有可修复的 critical 冲突', () => {
    const detector = new ConflictDetector();
    const result = detector.detectAndResolve({
      configs: healthyConfigs({ memoryWeightsVersion: '', skillStrategy: '' }),
    });

    const remainingFixable = result.unresolved.filter(
      (c) => c.severity === 'critical' && c.suggestedFix && Object.keys(c.suggestedFix).length > 0
    );
    expect(remainingFixable).toHaveLength(0);
  });

  it('无冲突时不迭代，返回原配置', () => {
    const detector = new ConflictDetector();
    const configs = healthyConfigs();
    const result = detector.detectAndResolve({ configs });

    expect(result.iterations).toBe(0);
    expect(result.resolved).toHaveLength(0);
    expect(result.configs).toEqual(configs);
  });

  it('规则循环时迭代次数受上限保护', () => {
    // 这条规则永远命中，且修复不会消除命中条件
    const detector = new ConflictDetector([
      {
        id: 'never-satisfied',
        severity: 'critical',
        description: 'fix never resolves the condition',
        involvedLayers: [EvolutionLayer.PROMPT],
        matches: () => true,
        fix: () => ({ promptVariantId: 'looped' }),
      },
    ] as any);

    const result = detector.detectAndResolve({ configs: healthyConfigs() });

    expect(result.iterations).toBeLessThanOrEqual(3);
    expect(result.unresolved.some((c) => c.id === 'never-satisfied')).toBe(true);
  });

  it('修复不改变与冲突无关的层配置', () => {
    const detector = new ConflictDetector();
    const result = detector.detectAndResolve({
      configs: healthyConfigs({ memoryWeightsVersion: '', promptVariantId: 'keep-me' }),
    });

    expect(result.configs.promptVariantId).toBe('keep-me');
    expect(result.configs.toolStrategy).toBe('thompson');
  });

  it('修复不会引入扩权类的策略值', () => {
    const detector = new ConflictDetector();
    const result = detector.detectAndResolve({
      configs: healthyConfigs({ skillStrategy: '', toolStrategy: '' }),
    });

    // 回退值必须是保守的默认值，而不是任何提升权限的策略
    expect(result.configs.skillStrategy).toBe('default');
    expect(result.configs.toolStrategy).toBe('default');
  });

  it('未解决的 critical 冲突通过 error 级别日志上报', () => {
    const detector = new ConflictDetector([
      {
        id: 'unfixable-critical',
        severity: 'critical',
        description: 'no fix available',
        involvedLayers: [EvolutionLayer.MEMORY],
        matches: () => true,
      },
    ] as any);

    detector.detectAndResolve({ configs: healthyConfigs() });

    expect(console.error).toHaveBeenCalled();
  });
});
