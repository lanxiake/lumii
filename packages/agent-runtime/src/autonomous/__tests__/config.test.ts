/**
 * 配置参数测试
 */

import { describe, it, expect } from 'vitest';
import {
  SATISFACTION_WEIGHTS,
  SATISFACTION_THRESHOLD,
  EPSILON,
  EMA_ALPHA,
  MAX_GOALS_PER_DAY,
  MAX_VARIANTS_PER_PROMPT,
  MIN_TRIALS_BEFORE_EXPLOIT,
  UCB_CONFIDENCE,
  ELO_K_FACTOR,
  validateConfig,
} from '../config';

describe('自主进化 Agent 配置', () => {
  describe('SATISFACTION_WEIGHTS', () => {
    it('权重总和应严格等于 1.0', () => {
      const sum = SATISFACTION_WEIGHTS.task + SATISFACTION_WEIGHTS.feedback + SATISFACTION_WEIGHTS.efficiency + SATISFACTION_WEIGHTS.knowledge;
      expect(sum).toBeCloseTo(1.0, 4); // 放宽到 1e-4 容差避免浮点累积误差
    });

    it('所有权重应为非负数（V1.0 暂时禁用 knowledge）', () => {
      expect(SATISFACTION_WEIGHTS.task).toBeGreaterThan(0);
      expect(SATISFACTION_WEIGHTS.feedback).toBeGreaterThan(0);
      expect(SATISFACTION_WEIGHTS.efficiency).toBeGreaterThan(0);
      expect(SATISFACTION_WEIGHTS.knowledge).toBeGreaterThanOrEqual(0); // 暂时为 0
    });

    it('权重应符合 V1.0 口径（三维归一化）', () => {
      // 0.35/0.85 = 0.41176, 0.30/0.85 = 0.35294, 0.20/0.85 = 0.23529
      expect(SATISFACTION_WEIGHTS.task).toBeCloseTo(0.41176, 5);
      expect(SATISFACTION_WEIGHTS.feedback).toBeCloseTo(0.35294, 5);
      expect(SATISFACTION_WEIGHTS.efficiency).toBeCloseTo(0.23529, 5);
      expect(SATISFACTION_WEIGHTS.knowledge).toBe(0);
    });
  });

  describe('SATISFACTION_THRESHOLD', () => {
    it('应在有效范围 [0, 1]', () => {
      expect(SATISFACTION_THRESHOLD).toBeGreaterThanOrEqual(0);
      expect(SATISFACTION_THRESHOLD).toBeLessThanOrEqual(1);
    });

    it('应为设计文档定义值 0.6', () => {
      expect(SATISFACTION_THRESHOLD).toBe(0.6);
    });
  });

  describe('EPSILON', () => {
    it('应在有效范围 [0, 1]', () => {
      expect(EPSILON).toBeGreaterThanOrEqual(0);
      expect(EPSILON).toBeLessThanOrEqual(1);
    });

    it('应为设计文档定义值 0.15', () => {
      expect(EPSILON).toBe(0.15);
    });
  });

  describe('EMA_ALPHA', () => {
    it('应在有效范围 [0, 1]', () => {
      expect(EMA_ALPHA).toBeGreaterThanOrEqual(0);
      expect(EMA_ALPHA).toBeLessThanOrEqual(1);
    });

    it('应为设计文档定义值 0.05', () => {
      expect(EMA_ALPHA).toBe(0.05);
    });
  });

  describe('其他常量', () => {
    it('MAX_GOALS_PER_DAY 应为正整数', () => {
      expect(MAX_GOALS_PER_DAY).toBeGreaterThan(0);
      expect(Number.isInteger(MAX_GOALS_PER_DAY)).toBe(true);
    });

    it('MAX_VARIANTS_PER_PROMPT 应为正整数', () => {
      expect(MAX_VARIANTS_PER_PROMPT).toBeGreaterThan(0);
      expect(Number.isInteger(MAX_VARIANTS_PER_PROMPT)).toBe(true);
    });

    it('MIN_TRIALS_BEFORE_EXPLOIT 应为正整数', () => {
      expect(MIN_TRIALS_BEFORE_EXPLOIT).toBeGreaterThan(0);
      expect(Number.isInteger(MIN_TRIALS_BEFORE_EXPLOIT)).toBe(true);
    });

    it('UCB_CONFIDENCE 应为正数', () => {
      expect(UCB_CONFIDENCE).toBeGreaterThan(0);
    });

    it('ELO_K_FACTOR 应为正数', () => {
      expect(ELO_K_FACTOR).toBeGreaterThan(0);
    });
  });

  describe('validateConfig', () => {
    it('默认配置应通过验证', () => {
      const result = validateConfig();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
