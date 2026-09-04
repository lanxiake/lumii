/**
 * 反思提示词模板
 * 用于 LLM 分析 Agent 表现并生成改进建议
 */

import type { SatisfactionScore, CapabilityState, CapabilityGap } from './types';

/**
 * 反思提示词模板
 * 输入：满意度评分历史 + 能力报告 + 最近会话摘要
 * 输出：结构化反思 JSON
 */
export const REFLECTION_PROMPT_TEMPLATE = `
你是一个自主进化 Agent 的元认知引擎，负责分析自身表现并提出改进建议。

## 输入数据

### 满意度评分历史（最近 7 天）
{{satisfactionHistory}}

### 能力状态报告
{{capabilityReport}}

### 最近会话摘要（最近 10 次对话）
{{recentSessions}}

## 任务

请进行深度自我反思，回答以下问题：

1. **问题诊断**
   - 主要问题是什么？（一句话概括）
   - 哪些满意度维度受到影响？（task/feedback/efficiency/knowledge）
   - 根本原因是什么？（深入分析，不要停留在表面）

2. **改进建议**
   - 针对根本原因，提出 2-4 条具体改进建议
   - 每条建议需说明：
     * 类型（prompt/capability/memory/workflow）
     * 具体描述（可操作的步骤）
     * 预期改善的维度
     * 可行性评估（0-1，考虑实施难度）
     * 预期影响（0-1，改善程度）

3. **学习目标建议**
   - 基于改进建议，生成 1-3 个学习目标
   - 每个目标需说明：
     * 目标类型（learning/proactive-message/capability-improvement）
     * 目标描述
     * 优先级（0-1）

## 输出格式

严格按照以下 JSON Schema 输出（不要包含其他文字）：

\`\`\`json
{
  "diagnosis": {
    "primaryIssue": "string",
    "affectedDimensions": ["task" | "feedback" | "efficiency" | "knowledge"],
    "rootCause": "string"
  },
  "recommendations": [
    {
      "type": "prompt" | "capability" | "memory" | "workflow",
      "description": "string",
      "targetDimensions": ["task" | "feedback" | "efficiency" | "knowledge"],
      "feasibility": 0.0-1.0,
      "impact": 0.0-1.0
    }
  ],
  "suggestedGoals": [
    {
      "type": "learning" | "proactive-message" | "capability-improvement",
      "description": "string",
      "priority": 0.0-1.0
    }
  ]
}
\`\`\`

## 约束

- 只分析数据中体现的问题，不要臆测
- 改进建议必须具体可操作，避免空泛建议（如"多学习"）
- 优先考虑高可行性、高影响的建议
- 学习目标不超过 3 个，聚焦最重要的改进方向
`;

/**
 * 构造反思提示词
 */
export function buildReflectionPrompt(
  satisfactionHistory: SatisfactionScore[],
  capabilityReport: {
    states: CapabilityState[];
    gaps: CapabilityGap[];
    overallLevel: number;
  },
  recentSessions: Array<{
    timestamp: string;
    taskSummary: string;
    satisfaction: number;
    toolCount: number;
    errorCount: number;
  }>
): string {
  // 格式化满意度历史
  const historyText =
    satisfactionHistory.length > 0
      ? satisfactionHistory
          .map(
            (s) =>
              `[${s.timestamp}] 总分: ${s.overall.toFixed(2)} (任务: ${s.taskCompletion.toFixed(2)}, 反馈: ${s.userFeedback.toFixed(2)}, 效率: ${s.efficiency.toFixed(2)}, 知识: ${s.knowledgeGrowth.toFixed(2)})`
          )
          .join('\n')
      : '无满意度评分历史';

  // 格式化能力报告
  const capabilityText = capabilityReport.states
    .map(
      (s) =>
        `- ${s.dimension}: 水平 ${s.level.toFixed(2)}, 置信度 ${s.confidence.toFixed(2)}, 测试次数 ${s.testCount}`
    )
    .join('\n');

  const gapsText =
    capabilityReport.gaps.length > 0
      ? capabilityReport.gaps
          .map(
            (g) =>
              `- ${g.dimension}: 当前 ${g.currentLevel.toFixed(2)} → 期望 ${g.desiredLevel.toFixed(2)} (缺口: ${g.gap.toFixed(2)}, 优先级: ${g.priority.toFixed(2)})`
          )
          .join('\n')
      : '无明显能力缺口';

  // 格式化会话摘要（脱敏）
  const sessionsText =
    recentSessions.length > 0
      ? recentSessions
          .map(
            (s) =>
              `[${s.timestamp}] 任务: ${s.taskSummary}, 满意度: ${s.satisfaction.toFixed(2)}, 工具使用: ${s.toolCount}, 错误: ${s.errorCount}`
          )
          .join('\n')
      : '无最近会话记录';

  // 替换模板占位符
  return REFLECTION_PROMPT_TEMPLATE.replace(
    '{{satisfactionHistory}}',
    historyText
  )
    .replace(
      '{{capabilityReport}}',
      `能力状态:\n${capabilityText}\n\n能力缺口:\n${gapsText}\n\n总体水平: ${capabilityReport.overallLevel.toFixed(2)}`
    )
    .replace('{{recentSessions}}', sessionsText);
}

/**
 * 解析 LLM 反思输出
 */
export function parseReflectionOutput(llmContent: string): {
  diagnosis: {
    primaryIssue: string;
    affectedDimensions: Array<'task' | 'feedback' | 'efficiency' | 'knowledge'>;
    rootCause: string;
  };
  recommendations: Array<{
    type: 'prompt' | 'capability' | 'memory' | 'workflow';
    description: string;
    targetDimensions: Array<'task' | 'feedback' | 'efficiency' | 'knowledge'>;
    feasibility: number;
    impact: number;
  }>;
  suggestedGoals: Array<{
    type: 'learning' | 'proactive-message' | 'capability-improvement';
    description: string;
    priority: number;
  }>;
} {
  // 提取 JSON 块
  const jsonMatch = llmContent.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    throw new Error('Failed to extract JSON from reflection output');
  }

  const parsed = JSON.parse(jsonMatch[1]);

  // 验证基本结构
  if (!parsed.diagnosis || !parsed.recommendations || !parsed.suggestedGoals) {
    throw new Error('Invalid reflection output structure');
  }

  return parsed;
}
