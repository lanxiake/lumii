/**
 * 反思提示词测试
 */

import { describe, expect, it } from 'vitest';
import {
  REFLECTION_PROMPT_TEMPLATE,
  buildReflectionPrompt,
  parseReflectionOutput,
} from '../reflection-prompts';
import { CapabilityDimension } from '../types';

describe('反思提示词', () => {
  describe('buildReflectionPrompt', () => {
    it('应正确构造反思提示词', () => {
      const satisfactionHistory = [
        {
          taskCompletion: 0.7,
          userFeedback: 0.6,
          efficiency: 0.8,
          knowledgeGrowth: 0.5,
          overall: 0.675,
          timestamp: '2026-09-01T00:00:00Z',
          sessionId: 'session-1',
          agentId: 'agent-1',
        },
      ];

      const capabilityReport = {
        states: [
          {
            dimension: CapabilityDimension.CODE_GENERATION,
            level: 0.6,
            confidence: 0.3,
            boundary: 0.6,
            lastUpdated: '2026-09-01T00:00:00Z',
            testCount: 10,
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
      };

      const recentSessions = [
        {
          timestamp: '2026-09-01T00:00:00Z',
          taskSummary: '实现快速排序',
          satisfaction: 0.7,
          toolCount: 5,
          errorCount: 0,
        },
      ];

      const prompt = buildReflectionPrompt(
        satisfactionHistory,
        capabilityReport,
        recentSessions
      );

      // 验证占位符已替换
      expect(prompt).not.toContain('{{satisfactionHistory}}');
      expect(prompt).not.toContain('{{capabilityReport}}');
      expect(prompt).not.toContain('{{recentSessions}}');

      // 验证包含关键数据
      expect(prompt).toContain('总分: 0.68');
      expect(prompt).toContain('code_generation');
      expect(prompt).toContain('实现快速排序');
    });

    it('应处理空数据', () => {
      const prompt = buildReflectionPrompt([], { states: [], gaps: [], overallLevel: 0.5 }, []);

      expect(prompt).toContain('无满意度评分历史');
      expect(prompt).toContain('无明显能力缺口');
      expect(prompt).toContain('无最近会话记录');
    });

    it('应包含模板的关键部分', () => {
      const prompt = buildReflectionPrompt([], { states: [], gaps: [], overallLevel: 0.5 }, []);

      expect(prompt).toContain('元认知引擎');
      expect(prompt).toContain('问题诊断');
      expect(prompt).toContain('改进建议');
      expect(prompt).toContain('学习目标建议');
      expect(prompt).toContain('JSON Schema');
    });
  });

  describe('parseReflectionOutput', () => {
    it('应正确解析有效的 JSON 输出', () => {
      const llmContent = `
这是一些文本

\`\`\`json
{
  "diagnosis": {
    "primaryIssue": "代码质量不稳定",
    "affectedDimensions": ["task", "efficiency"],
    "rootCause": "缺乏系统的错误处理机制"
  },
  "recommendations": [
    {
      "type": "prompt",
      "description": "优化错误处理提示词",
      "targetDimensions": ["task", "efficiency"],
      "feasibility": 0.8,
      "impact": 0.7
    }
  ],
  "suggestedGoals": [
    {
      "type": "learning",
      "description": "学习最佳错误处理实践",
      "priority": 0.8
    }
  ]
}
\`\`\`

更多文本
`;

      const result = parseReflectionOutput(llmContent);

      expect(result.diagnosis.primaryIssue).toBe('代码质量不稳定');
      expect(result.diagnosis.affectedDimensions).toEqual(['task', 'efficiency']);
      expect(result.diagnosis.rootCause).toBe('缺乏系统的错误处理机制');
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].type).toBe('prompt');
      expect(result.suggestedGoals).toHaveLength(1);
      expect(result.suggestedGoals[0].type).toBe('learning');
    });

    it('应在缺少 JSON 块时抛出错误', () => {
      const llmContent = '这里没有 JSON 块';

      expect(() => parseReflectionOutput(llmContent)).toThrow(
        'Failed to extract JSON from reflection output'
      );
    });

    it('应在 JSON 格式错误时抛出错误', () => {
      const llmContent = `
\`\`\`json
{
  "invalid": "json"
}
\`\`\`
`;

      expect(() => parseReflectionOutput(llmContent)).toThrow(
        'Invalid reflection output structure'
      );
    });

    it('应处理带有额外空白的 JSON', () => {
      const llmContent = `
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
`;

      const result = parseReflectionOutput(llmContent);
      expect(result.diagnosis.primaryIssue).toBe('测试');
    });
  });

  describe('REFLECTION_PROMPT_TEMPLATE', () => {
    it('应包含所有必要的占位符', () => {
      expect(REFLECTION_PROMPT_TEMPLATE).toContain('{{satisfactionHistory}}');
      expect(REFLECTION_PROMPT_TEMPLATE).toContain('{{capabilityReport}}');
      expect(REFLECTION_PROMPT_TEMPLATE).toContain('{{recentSessions}}');
    });

    it('应包含输出格式说明', () => {
      expect(REFLECTION_PROMPT_TEMPLATE).toContain('JSON Schema');
      expect(REFLECTION_PROMPT_TEMPLATE).toContain('diagnosis');
      expect(REFLECTION_PROMPT_TEMPLATE).toContain('recommendations');
      expect(REFLECTION_PROMPT_TEMPLATE).toContain('suggestedGoals');
    });

    it('应包含约束条件', () => {
      expect(REFLECTION_PROMPT_TEMPLATE).toContain('约束');
      expect(REFLECTION_PROMPT_TEMPLATE).toContain('不要臆测');
      expect(REFLECTION_PROMPT_TEMPLATE).toContain('具体可操作');
    });
  });
});
