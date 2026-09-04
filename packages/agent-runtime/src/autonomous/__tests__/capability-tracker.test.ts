/**
 * 能力追踪器测试
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { CapabilityTracker } from '../capability-tracker';
import { CapabilityDimension } from '../types';

// Mock DatabaseClient
class MockDatabaseClient {
  private data: Map<string, any[]> = new Map();

  async findOne<T = any>(table: string, where: Record<string, any>): Promise<T | null> {
    const rows = this.data.get(table) || [];
    const found = rows.find((row) => {
      return Object.keys(where).every((key) => row[key] === where[key]);
    });
    return (found as T) || null;
  }

  async find<T = any>(
    table: string,
    where: Record<string, any>,
    options?: { limit?: number; orderBy?: Record<string, 'ASC' | 'DESC'> }
  ): Promise<T[]> {
    const rows = this.data.get(table) || [];
    let filtered = rows.filter((row) => {
      return Object.keys(where).every((key) => row[key] === where[key]);
    });

    if (options?.orderBy) {
      const [sortKey, sortDir] = Object.entries(options.orderBy)[0];
      filtered.sort((a, b) => {
        const aVal = a[sortKey];
        const bVal = b[sortKey];
        return sortDir === 'ASC' ? (aVal > bVal ? 1 : -1) : (aVal < bVal ? 1 : -1);
      });
    }

    if (options?.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered as T[];
  }

  async insert(table: string, data: Record<string, any>): Promise<void> {
    const rows = this.data.get(table) || [];
    rows.push(data);
    this.data.set(table, rows);
  }

  async upsert(table: string, where: Record<string, any>, data: Record<string, any>): Promise<void> {
    const rows = this.data.get(table) || [];
    const index = rows.findIndex((row) => {
      return Object.keys(where).every((key) => row[key] === where[key]);
    });

    if (index >= 0) {
      rows[index] = { ...rows[index], ...where, ...data };
    } else {
      rows.push({ ...where, ...data });
    }
    this.data.set(table, rows);
  }

  reset() {
    this.data.clear();
  }
}

describe('CapabilityTracker', () => {
  let db: MockDatabaseClient;
  let tracker: CapabilityTracker;
  const testAgentId = 'test-agent-001';
  const testSessionId = 'test-session-001';

  beforeEach(() => {
    db = new MockDatabaseClient();
    tracker = new CapabilityTracker(db as any);
  });

  describe('getCapabilityState', () => {
    it('应返回默认状态当维度不存在', async () => {
      const state = await tracker.getCapabilityState(
        testAgentId,
        CapabilityDimension.CODE_GENERATION
      );

      expect(state.dimension).toBe(CapabilityDimension.CODE_GENERATION);
      expect(state.level).toBe(0.5);
      expect(state.confidence).toBe(0);
      expect(state.boundary).toBe(0.5);
      expect(state.testCount).toBe(0);
    });

    it('应返回已存储的状态', async () => {
      await db.insert('capability_dimensions', {
        agent_id: testAgentId,
        dimension: CapabilityDimension.CODE_GENERATION,
        level: 0.7,
        confidence: 0.5,
        boundary: 0.7,
        test_count: 20,
        last_updated: '2026-09-04T00:00:00Z',
      });

      const state = await tracker.getCapabilityState(
        testAgentId,
        CapabilityDimension.CODE_GENERATION
      );

      expect(state.level).toBe(0.7);
      expect(state.confidence).toBe(0.5);
      expect(state.boundary).toBe(0.7);
      expect(state.testCount).toBe(20);
    });
  });

  describe('recordTest', () => {
    it('应正确记录测试并更新能力水平', async () => {
      const test = {
        agentId: testAgentId,
        sessionId: testSessionId,
        dimension: CapabilityDimension.CODE_GENERATION,
        taskSummary: '实现快速排序算法',
        difficulty: 0.7,
        result: 'success' as const,
      };

      const updatedState = await tracker.recordTest(test);

      // 验证能力水平提升（成功完成困难任务）
      expect(updatedState.level).toBeGreaterThan(0.5);
      expect(updatedState.testCount).toBe(1);
      expect(updatedState.confidence).toBeGreaterThan(0);

      // 验证测试记录被持久化
      const tests = await db.find('capability_tests', { agent_id: testAgentId });
      expect(tests).toHaveLength(1);
      expect(tests[0].result).toBe('success');
      expect(tests[0].difficulty).toBe(0.7);
    });

    it('应在失败时降低能力水平', async () => {
      const test = {
        agentId: testAgentId,
        sessionId: testSessionId,
        dimension: CapabilityDimension.CODE_GENERATION,
        taskSummary: '实现简单函数',
        difficulty: 0.3,
        result: 'failure' as const,
      };

      const updatedState = await tracker.recordTest(test);

      // 验证能力水平下降（失败完成简单任务）
      expect(updatedState.level).toBeLessThan(0.5);
    });

    it('应正确累积测试次数和置信度', async () => {
      const tests = [
        {
          agentId: testAgentId,
          sessionId: testSessionId,
          dimension: CapabilityDimension.CODE_GENERATION,
          taskSummary: '测试1',
          difficulty: 0.5,
          result: 'success' as const,
        },
        {
          agentId: testAgentId,
          sessionId: testSessionId,
          dimension: CapabilityDimension.CODE_GENERATION,
          taskSummary: '测试2',
          difficulty: 0.6,
          result: 'success' as const,
        },
        {
          agentId: testAgentId,
          sessionId: testSessionId,
          dimension: CapabilityDimension.CODE_GENERATION,
          taskSummary: '测试3',
          difficulty: 0.4,
          result: 'partial' as const,
        },
      ];

      let confidence = 0;
      for (const test of tests) {
        const state = await tracker.recordTest(test);
        confidence = state.confidence;
      }

      // 验证测试次数累积
      const finalState = await tracker.getCapabilityState(
        testAgentId,
        CapabilityDimension.CODE_GENERATION
      );
      expect(finalState.testCount).toBe(3);
      expect(finalState.confidence).toBeGreaterThan(0);
      expect(finalState.confidence).toBe(confidence);
    });
  });

  describe('identifyGaps', () => {
    it('应返回空数组当无测试历史', async () => {
      const gaps = await tracker.identifyGaps(testAgentId);
      expect(gaps).toEqual([]);
    });

    it('应识别能力缺口', async () => {
      // 模拟用户频繁使用代码生成功能（需求高）
      const now = new Date();
      for (let i = 0; i < 10; i++) {
        await db.insert('capability_tests', {
          id: `test-${i}`,
          agent_id: testAgentId,
          session_id: testSessionId,
          dimension: CapabilityDimension.CODE_GENERATION,
          task_summary: `任务${i}`,
          difficulty: 0.5,
          result: 'success',
          created_at: new Date(now.getTime() - i * 86400000).toISOString(),
        });
      }

      // 设置当前能力水平为 0.5（低于期望）
      await db.upsert(
        'capability_dimensions',
        {
          agent_id: testAgentId,
          dimension: CapabilityDimension.CODE_GENERATION,
        },
        {
          level: 0.5,
          confidence: 0.4,
          boundary: 0.5,
          test_count: 10,
          last_updated: now.toISOString(),
        }
      );

      const gaps = await tracker.identifyGaps(testAgentId);

      // 验证识别到代码生成维度的缺口
      expect(gaps.length).toBeGreaterThan(0);
      const codeGenGap = gaps.find(
        (g) => g.dimension === CapabilityDimension.CODE_GENERATION
      );
      expect(codeGenGap).toBeDefined();
      expect(codeGenGap!.currentLevel).toBe(0.5);
      expect(codeGenGap!.desiredLevel).toBeGreaterThan(0.5);
      expect(codeGenGap!.gap).toBeGreaterThan(0);
    });

    it('应按优先级排序缺口', async () => {
      const now = new Date();

      // 高需求维度（10 次测试）
      for (let i = 0; i < 10; i++) {
        await db.insert('capability_tests', {
          id: `code-${i}`,
          agent_id: testAgentId,
          session_id: testSessionId,
          dimension: CapabilityDimension.CODE_GENERATION,
          task_summary: `代码任务${i}`,
          difficulty: 0.5,
          result: 'success',
          created_at: new Date(now.getTime() - i * 86400000).toISOString(),
        });
      }

      // 低需求维度（2 次测试）
      for (let i = 0; i < 2; i++) {
        await db.insert('capability_tests', {
          id: `doc-${i}`,
          agent_id: testAgentId,
          session_id: testSessionId,
          dimension: CapabilityDimension.DOCUMENT_ANALYSIS,
          task_summary: `文档任务${i}`,
          difficulty: 0.5,
          result: 'success',
          created_at: new Date(now.getTime() - i * 86400000).toISOString(),
        });
      }

      // 设置两个维度都有缺口
      for (const dim of [
        CapabilityDimension.CODE_GENERATION,
        CapabilityDimension.DOCUMENT_ANALYSIS,
      ]) {
        await db.upsert(
          'capability_dimensions',
          { agent_id: testAgentId, dimension: dim },
          {
            level: 0.5,
            confidence: 0.3,
            boundary: 0.5,
            test_count: 10,
            last_updated: now.toISOString(),
          }
        );
      }

      const gaps = await tracker.identifyGaps(testAgentId);

      // 验证高需求维度排在前面
      expect(gaps[0].dimension).toBe(CapabilityDimension.CODE_GENERATION);
      expect(gaps[0].priority).toBeGreaterThan(gaps[gaps.length - 1].priority);
    });
  });

  describe('getCapabilityReport', () => {
    it('应返回完整的能力报告', async () => {
      const now = new Date();

      // 添加一些测试记录
      await db.insert('capability_tests', {
        id: 'test-1',
        agent_id: testAgentId,
        session_id: testSessionId,
        dimension: CapabilityDimension.CODE_GENERATION,
        task_summary: '测试任务',
        difficulty: 0.5,
        result: 'success',
        created_at: now.toISOString(),
      });

      await db.upsert(
        'capability_dimensions',
        {
          agent_id: testAgentId,
          dimension: CapabilityDimension.CODE_GENERATION,
        },
        {
          level: 0.6,
          confidence: 0.3,
          boundary: 0.6,
          test_count: 5,
          last_updated: now.toISOString(),
        }
      );

      const report = await tracker.getCapabilityReport(testAgentId);

      expect(report.states).toHaveLength(8); // 8 个能力维度
      expect(report.gaps).toBeDefined();
      expect(report.overallLevel).toBeGreaterThan(0);
      expect(report.overallLevel).toBeLessThanOrEqual(1);
    });

    it('应正确计算加权平均能力水平', async () => {
      const now = new Date();

      // 设置两个维度：一个高水平高置信度，一个低水平低置信度
      await db.upsert(
        'capability_dimensions',
        {
          agent_id: testAgentId,
          dimension: CapabilityDimension.CODE_GENERATION,
        },
        {
          level: 0.8,
          confidence: 0.6,
          boundary: 0.8,
          test_count: 30,
          last_updated: now.toISOString(),
        }
      );

      await db.upsert(
        'capability_dimensions',
        {
          agent_id: testAgentId,
          dimension: CapabilityDimension.DOCUMENT_ANALYSIS,
        },
        {
          level: 0.3,
          confidence: 0.1,
          boundary: 0.3,
          test_count: 2,
          last_updated: now.toISOString(),
        }
      );

      const report = await tracker.getCapabilityReport(testAgentId);

      // 加权平均应更接近高置信度的维度
      // overallLevel = (0.8 * 0.6 + 0.3 * 0.1 + 0.5 * 0 * 6) / (0.6 + 0.1 + 0 * 6)
      // ≈ (0.48 + 0.03) / 0.7 ≈ 0.73
      expect(report.overallLevel).toBeGreaterThan(0.6);
      expect(report.overallLevel).toBeLessThan(0.8);
    });
  });
});
