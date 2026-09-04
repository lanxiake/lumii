/**
 * 反思引擎测试
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ReflectionEngine } from '../reflection-engine';
import { CapabilityDimension } from '../types';

describe('ReflectionEngine', () => {
  let mockDb: any;
  let mockLlmClient: any;
  let mockMetaCognition: any;
  let mockCapabilityTracker: any;
  let engine: ReflectionEngine;

  beforeEach(() => {
    mockDb = {
      findOne: vi.fn(),
      find: vi.fn(),
      insert: vi.fn(),
    };

    mockLlmClient = {
      complete: vi.fn(),
    };

    mockMetaCognition = {
      getRecentScores: vi.fn(),
    };

    mockCapabilityTracker = {
      getCapabilityReport: vi.fn(),
    };

    engine = new ReflectionEngine(
      mockDb,
      mockLlmClient,
      mockMetaCognition,
      mockCapabilityTracker
    );
  });

  describe('reflect', () => {
    it('应成功执行完整反思流程', async () => {
      // 准备 mock 数据
      mockMetaCognition.getRecentScores.mockResolvedValue([
        {
          taskCompletion: 0.6,
          userFeedback: 0.5,
          efficiency: 0.7,
          knowledgeGrowth: 0.4,
          overall: 0.55,
          timestamp: '2026-09-01T00:00:00Z',
          sessionId: 'session-1',
          agentId: 'agent-1',
        },
      ]);

      mockCapabilityTracker.getCapabilityReport.mockResolvedValue({
        states: [
          {
            dimension: CapabilityDimension.CODE_GENERATION,
            level: 0.6,
            confidence: 0.5,
            boundary: 0.6,
            lastUpdated: '2026-09-01T00:00:00Z',
            testCount: 20,
          },
        ],
        gaps: [
          {
            dimension: CapabilityDimension.CODE_GENERATION,
            currentLevel: 0.6,
            desiredLevel: 0.8,
            gap: 0.2,
            priority: 0.15,
            demandFrequency: 0.75,
          },
        ],
        overallLevel: 0.6,
      });

      mockDb.find.mockResolvedValue([
        {
          created_at: '2026-09-01T00:00:00Z',
          task_summary: '实现快速排序',
          overall_score: 0.7,
          tool_call_count: 5,
          error_count: 0,
        },
      ]);

      mockLlmClient.complete.mockResolvedValue({
        content: `
这是反思分析

\`\`\`json
{
  "diagnosis": {
    "primaryIssue": "代码生成准确率不稳定",
    "affectedDimensions": ["task", "knowledge"],
    "rootCause": "缺少对复杂算法的系统理解"
  },
  "recommendations": [
    {
      "type": "capability",
      "description": "加强算法和数据结构训练",
      "targetDimensions": ["task", "knowledge"],
      "feasibility": 0.8,
      "impact": 0.7
    }
  ],
  "suggestedGoals": [
    {
      "type": "learning",
      "description": "学习常见算法模式",
      "priority": 0.8
    }
  ]
}
\`\`\`
`,
      });

      mockDb.insert.mockResolvedValue(undefined);

      // 执行反思
      const result = await engine.reflect('agent-1', 'scheduled');

      // 验证返回结果
      expect(result.agentId).toBe('agent-1');
      expect(result.triggerReason).toBe('scheduled');
      expect(result.diagnosis.primaryIssue).toBe('代码生成准确率不稳定');
      expect(result.recommendations).toHaveLength(1);
      expect(result.suggestedGoals).toHaveLength(1);

      // 验证调用了正确的方法
      expect(mockMetaCognition.getRecentScores).toHaveBeenCalledWith('agent-1', 7);
      expect(mockCapabilityTracker.getCapabilityReport).toHaveBeenCalledWith('agent-1');
      expect(mockDb.find).toHaveBeenCalled();

      // 验证 LLM 调用参数
      expect(mockLlmClient.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-5',
          temperature: 0.3,
          maxTokens: 2000,
        })
      );

      // 验证持久化
      expect(mockDb.insert).toHaveBeenCalledWith(
        'reflections',
        expect.objectContaining({
          agent_id: 'agent-1',
          trigger_reason: 'scheduled',
          primary_issue: '代码生成准确率不稳定',
        })
      );
    });

    it('应正确处理 LLM 调用失败', async () => {
      mockMetaCognition.getRecentScores.mockResolvedValue([]);
      mockCapabilityTracker.getCapabilityReport.mockResolvedValue({
        states: [],
        gaps: [],
        overallLevel: 0.5,
      });
      mockDb.find.mockResolvedValue([]);

      mockLlmClient.complete.mockRejectedValue(new Error('LLM 服务不可用'));

      await expect(engine.reflect('agent-1', 'low-satisfaction')).rejects.toThrow(
        'LLM 服务不可用'
      );
    });

    it('应正确处理 JSON 解析失败', async () => {
      mockMetaCognition.getRecentScores.mockResolvedValue([]);
      mockCapabilityTracker.getCapabilityReport.mockResolvedValue({
        states: [],
        gaps: [],
        overallLevel: 0.5,
      });
      mockDb.find.mockResolvedValue([]);

      mockLlmClient.complete.mockResolvedValue({
        content: '这里没有 JSON',
      });

      await expect(engine.reflect('agent-1', 'user-request')).rejects.toThrow();
    });

    it('应处理空数据输入', async () => {
      mockMetaCognition.getRecentScores.mockResolvedValue([]);
      mockCapabilityTracker.getCapabilityReport.mockResolvedValue({
        states: [],
        gaps: [],
        overallLevel: 0.5,
      });
      mockDb.find.mockResolvedValue([]);

      mockLlmClient.complete.mockResolvedValue({
        content: `
\`\`\`json
{
  "diagnosis": {
    "primaryIssue": "数据不足",
    "affectedDimensions": [],
    "rootCause": "无足够历史数据"
  },
  "recommendations": [],
  "suggestedGoals": []
}
\`\`\`
`,
      });

      mockDb.insert.mockResolvedValue(undefined);

      const result = await engine.reflect('agent-1', 'scheduled');

      expect(result.diagnosis.primaryIssue).toBe('数据不足');
      expect(result.recommendations).toHaveLength(0);
      expect(result.suggestedGoals).toHaveLength(0);
    });
  });

  describe('getRecentReflections', () => {
    it('应返回最近的反思记录', async () => {
      const mockRows = [
        {
          id: 'reflection-1',
          agent_id: 'agent-1',
          trigger_reason: 'scheduled',
          primary_issue: '测试问题',
          affected_dimensions: '["task"]',
          root_cause: '测试原因',
          recommendations: '[{"type":"prompt","description":"测试","targetDimensions":["task"],"feasibility":0.8,"impact":0.7}]',
          suggested_goals: '[{"type":"learning","description":"测试目标","priority":0.8}]',
          analysis_window_start: '2026-08-25T00:00:00Z',
          analysis_window_end: '2026-09-01T00:00:00Z',
          created_at: '2026-09-01T00:00:00Z',
        },
      ];

      mockDb.find.mockResolvedValue(mockRows);

      const result = await engine.getRecentReflections('agent-1', 5);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('reflection-1');
      expect(result[0].diagnosis.primaryIssue).toBe('测试问题');
      expect(result[0].recommendations).toHaveLength(1);
      expect(result[0].suggestedGoals).toHaveLength(1);

      expect(mockDb.find).toHaveBeenCalledWith(
        'reflections',
        { agent_id: 'agent-1' },
        { limit: 5, orderBy: { created_at: 'DESC' } }
      );
    });

    it('应处理数据库查询失败', async () => {
      mockDb.find.mockRejectedValue(new Error('数据库错误'));

      const result = await engine.getRecentReflections('agent-1');

      expect(result).toEqual([]);
    });

    it('应处理空结果', async () => {
      mockDb.find.mockResolvedValue([]);

      const result = await engine.getRecentReflections('agent-1');

      expect(result).toEqual([]);
    });
  });

  describe('getRecentSessionSummaries (private method)', () => {
    it('应通过 reflect 测试会话摘要提取', async () => {
      mockMetaCognition.getRecentScores.mockResolvedValue([]);
      mockCapabilityTracker.getCapabilityReport.mockResolvedValue({
        states: [],
        gaps: [],
        overallLevel: 0.5,
      });

      // 准备会话数据
      mockDb.find.mockResolvedValue([
        {
          created_at: '2026-09-01T10:00:00Z',
          task_summary: '实现二分查找',
          overall_score: 0.85,
          tool_call_count: 3,
          error_count: 0,
        },
        {
          created_at: '2026-09-01T09:00:00Z',
          task_summary: null, // 测试空任务摘要
          overall_score: 0.6,
          tool_call_count: 5,
          error_count: 2,
        },
      ]);

      mockLlmClient.complete.mockResolvedValue({
        content: `
\`\`\`json
{
  "diagnosis": {
    "primaryIssue": "测试",
    "affectedDimensions": ["task"],
    "rootCause": "测试"
  },
  "recommendations": [],
  "suggestedGoals": []
}
\`\`\`
`,
      });

      mockDb.insert.mockResolvedValue(undefined);

      await engine.reflect('agent-1', 'scheduled');

      // 验证 prompt 包含会话信息
      const llmCall = mockLlmClient.complete.mock.calls[0][0];
      expect(llmCall.prompt).toContain('实现二分查找');
      expect(llmCall.prompt).toContain('未知任务'); // 处理空 task_summary
    });
  });
});
