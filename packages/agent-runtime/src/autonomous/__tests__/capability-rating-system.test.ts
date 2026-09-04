/**
 * 能力评级系统测试
 */

import { describe, expect, it } from 'vitest';
import { CapabilityRatingSystem } from '../capability-rating-system';
import { ELO_K_FACTOR } from '../config';

describe('CapabilityRatingSystem', () => {
  const system = new CapabilityRatingSystem();

  describe('expectedPerformance', () => {
    it('应返回 0.5 当 level = difficulty', () => {
      const result = system.expectedPerformance(0.5, 0.5);
      expect(result).toBeCloseTo(0.5, 2);
    });

    it('应返回 > 0.5 当 level > difficulty', () => {
      const result = system.expectedPerformance(0.7, 0.5);
      expect(result).toBeGreaterThan(0.5);
    });

    it('应返回 < 0.5 当 level < difficulty', () => {
      const result = system.expectedPerformance(0.3, 0.5);
      expect(result).toBeLessThan(0.5);
    });

    it('应返回接近 1.0 当 level >> difficulty', () => {
      const result = system.expectedPerformance(0.9, 0.3);
      expect(result).toBeGreaterThan(0.95);
    });

    it('应返回接近 0.0 当 level << difficulty', () => {
      const result = system.expectedPerformance(0.1, 0.9);
      expect(result).toBeLessThan(0.05);
    });
  });

  describe('updateRating', () => {
    it('应增加能力水平当成功执行困难任务', () => {
      const currentLevel = 0.5;
      const difficulty = 0.7;
      const newLevel = system.updateRating(currentLevel, difficulty, 'success');

      expect(newLevel).toBeGreaterThan(currentLevel);
    });

    it('应降低能力水平当失败执行简单任务', () => {
      const currentLevel = 0.5;
      const difficulty = 0.3;
      const newLevel = system.updateRating(currentLevel, difficulty, 'failure');

      expect(newLevel).toBeLessThan(currentLevel);
    });

    it('应保持接近原水平当 actual = expected', () => {
      const currentLevel = 0.5;
      const difficulty = 0.5;
      const newLevel = system.updateRating(currentLevel, difficulty, 'partial');

      expect(Math.abs(newLevel - currentLevel)).toBeLessThan(0.05);
    });

    it('应使用正确的 Elo 更新公式', () => {
      const currentLevel = 0.5;
      const difficulty = 0.5;
      const expected = system.expectedPerformance(currentLevel, difficulty);
      const actual = 1.0; // success
      const normalizedK = ELO_K_FACTOR / 100;
      const expectedNewLevel = currentLevel + normalizedK * (actual - expected);

      const newLevel = system.updateRating(currentLevel, difficulty, 'success');

      expect(newLevel).toBeCloseTo(expectedNewLevel, 5);
    });

    it('应限制更新后的水平在 [0, 1] 范围内', () => {
      // 测试下界
      const lowLevel = system.updateRating(0.05, 0.01, 'failure');
      expect(lowLevel).toBeGreaterThanOrEqual(0);

      // 测试上界
      const highLevel = system.updateRating(0.95, 0.99, 'success');
      expect(highLevel).toBeLessThanOrEqual(1);
    });

    it('应正确处理 partial 结果（actual = 0.5）', () => {
      const currentLevel = 0.6;
      const difficulty = 0.4;
      const expected = system.expectedPerformance(currentLevel, difficulty);
      const actual = 0.5;
      const normalizedK = ELO_K_FACTOR / 100;
      const expectedNewLevel = currentLevel + normalizedK * (actual - expected);

      const newLevel = system.updateRating(currentLevel, difficulty, 'partial');

      expect(newLevel).toBeCloseTo(expectedNewLevel, 5);
    });
  });

  describe('findBoundary', () => {
    it('应返回 level 本身（50% 成功率的难度）', () => {
      expect(system.findBoundary(0.3)).toBe(0.3);
      expect(system.findBoundary(0.5)).toBe(0.5);
      expect(system.findBoundary(0.7)).toBe(0.7);
    });

    it('验证边界处的预期表现概率为 0.5', () => {
      const level = 0.6;
      const boundary = system.findBoundary(level);
      const expected = system.expectedPerformance(level, boundary);

      expect(expected).toBeCloseTo(0.5, 2);
    });
  });

  describe('computeConfidence', () => {
    it('应返回 0 当测试次数为 0', () => {
      expect(system.computeConfidence(0)).toBe(0);
    });

    it('应返回约 0.63 当测试次数为 20', () => {
      const confidence = system.computeConfidence(20);
      expect(confidence).toBeCloseTo(0.63, 1);
    });

    it('应返回约 0.95 当测试次数为 60', () => {
      const confidence = system.computeConfidence(60);
      expect(confidence).toBeCloseTo(0.95, 1);
    });

    it('应随测试次数单调递增', () => {
      const conf1 = system.computeConfidence(10);
      const conf2 = system.computeConfidence(20);
      const conf3 = system.computeConfidence(50);

      expect(conf2).toBeGreaterThan(conf1);
      expect(conf3).toBeGreaterThan(conf2);
    });

    it('应收敛到 1.0（但永不达到）', () => {
      const conf100 = system.computeConfidence(100);
      const conf200 = system.computeConfidence(200);

      expect(conf100).toBeLessThan(1.0);
      expect(conf200).toBeLessThan(1.0);
      expect(conf200).toBeGreaterThan(conf100);
      expect(conf200).toBeGreaterThan(0.99);
    });
  });

  describe('自定义 K 值', () => {
    it('应使用构造函数提供的 K 值', () => {
      const customK = 64;
      const customSystem = new CapabilityRatingSystem(customK);

      const currentLevel = 0.5;
      const difficulty = 0.5;
      const expected = customSystem.expectedPerformance(currentLevel, difficulty);
      const actual = 1.0;
      const normalizedK = customK / 100;
      const expectedNewLevel = currentLevel + normalizedK * (actual - expected);

      const newLevel = customSystem.updateRating(currentLevel, difficulty, 'success');

      expect(newLevel).toBeCloseTo(expectedNewLevel, 5);
    });

    it('较大的 K 值应产生更大的更新幅度', () => {
      const systemK32 = new CapabilityRatingSystem(32);
      const systemK64 = new CapabilityRatingSystem(64);

      const currentLevel = 0.5;
      const difficulty = 0.7;

      const newLevelK32 = systemK32.updateRating(currentLevel, difficulty, 'success');
      const newLevelK64 = systemK64.updateRating(currentLevel, difficulty, 'success');

      const deltaK32 = newLevelK32 - currentLevel;
      const deltaK64 = newLevelK64 - currentLevel;

      expect(deltaK64).toBeGreaterThan(deltaK32);
    });
  });
});
