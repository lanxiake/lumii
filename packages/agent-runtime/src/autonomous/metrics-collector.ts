/**
 * 指标收集器
 *
 * 从 Agent 会话提取原始指标，用于满意度评分计算
 */

/**
 * 会话指标（从 Agent 会话提取的原始数据）
 */
export interface SessionMetrics {
  sessionId: string;
  agentId: string;
  startTime: string;
  endTime: string;
  /** 消息数 */
  messageCount: number;
  /** 工具调用次数 */
  toolCallCount: number;
  /** 错误次数 */
  errorCount: number;
  /** 用户交互次数 */
  userInteractionCount: number;
  /** 知识查询次数 */
  knowledgeQueriesCount: number;
  /** 任务描述摘要 */
  taskDescription?: string;
}

/**
 * Agent 会话接口（简化版，匹配实际 Agent 会话结构）
 */
export interface AgentSession {
  id: string;
  agentId: string;
  startedAt: Date;
  endedAt?: Date;
  messages?: Array<{ role: string; content: any }>;
  toolCalls?: Array<{ success: boolean }>;
  errors?: Array<{ message: string }>;
  [key: string]: any;
}

/**
 * 提取任务完成度
 * 公式：1 - (errorCount / max(toolCallCount, 1)) * 0.5
 * 范围：[0, 1]
 */
export function extractTaskCompletion(metrics: SessionMetrics): number {
  const errorRate = metrics.errorCount / Math.max(metrics.toolCallCount, 1);
  const completion = 1 - errorRate * 0.5;
  return Math.max(0, Math.min(1, completion));
}

/**
 * 提取用户反馈质量
 * 公式：min(userInteractionCount / max(messageCount, 1), 1.0)
 * 无交互时返回 0.5（中性）
 */
export function extractUserFeedback(metrics: SessionMetrics): number {
  if (metrics.userInteractionCount === 0) {
    return 0.5; // 中性值
  }
  const interactionRate = metrics.userInteractionCount / Math.max(metrics.messageCount, 1);
  return Math.min(interactionRate, 1.0);
}

/**
 * 提取效率
 * 公式：1 / (1 + log10(durationMs / max(messageCount, 1) / 1000))
 * 使用对数归一化避免极端值
 */
export function extractEfficiency(metrics: SessionMetrics): number {
  const startMs = new Date(metrics.startTime).getTime();
  const endMs = new Date(metrics.endTime).getTime();
  const durationMs = Math.max(endMs - startMs, 1);
  const messageCount = Math.max(metrics.messageCount, 1);

  const avgTimePerMessage = durationMs / messageCount / 1000; // 秒
  const efficiency = 1 / (1 + Math.log10(Math.max(avgTimePerMessage, 0.1)));

  return Math.max(0, Math.min(1, efficiency));
}

/**
 * 提取知识增长
 * 公式：min(knowledgeQueriesCount / max(messageCount, 1) * 2, 1.0)
 * 查询占比超过 50% 时返回 1.0
 */
export function extractKnowledgeGrowth(metrics: SessionMetrics): number {
  const queryRate = metrics.knowledgeQueriesCount / Math.max(metrics.messageCount, 1);
  return Math.min(queryRate * 2, 1.0);
}

/**
 * 从 Agent 会话收集指标
 */
export function collectMetricsFromSession(session: AgentSession): SessionMetrics {
  const messageCount = session.messages?.length || 0;
  const toolCallCount = session.toolCalls?.length || 0;
  const errorCount = session.errors?.length || 0;

  // 统计用户交互次数（用户消息数）
  const userInteractionCount = session.messages?.filter((msg: any) => msg.role === 'user').length || 0;

  // 统计知识查询次数（假设：工具调用中包含记忆/知识查询）
  const knowledgeQueriesCount = 0; // 简化处理，实际应从工具调用中统计

  return {
    sessionId: session.id,
    agentId: session.agentId,
    startTime: session.startedAt?.toISOString() || new Date().toISOString(),
    endTime: session.endedAt?.toISOString() || new Date().toISOString(),
    messageCount,
    toolCallCount,
    errorCount,
    userInteractionCount,
    knowledgeQueriesCount,
    taskDescription: session.messages?.[0]?.content?.substring(0, 100),
  };
}
