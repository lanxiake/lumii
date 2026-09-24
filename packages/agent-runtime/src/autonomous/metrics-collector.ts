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
  /**
   * 会话摘要（`file_read×3, grep×1`）——由工具调用聚合，落到 `task_summary` 列。
   *
   * ⚠ **它不是任务描述**：真实的任务描述在这条链上取不到——`buildSessionSnapshot`
   * 刻意把消息正文抹成空串（不把用户原话喂给自主进化）。工具序列是唯一既能反映
   * "这个会话干了什么"、又不带用户内容的机器可读信号。
   *
   * 没有工具调用时为 `undefined`（不是空串）：让"没有"与"有但是空"可分，
   * 免得下游再编一个看起来像真值的兜底。
   */
  taskDescription?: string;
  /**
   * 用户反馈分值覆盖（V1.0）。
   *
   * 由外层从真实负反馈信号（编辑/重发/打断）推导后注入。
   * 消息数比值在单轮对话中恒为 0.5，不携带信息，故提供此覆盖入口。
   * 未提供时回退到消息数比值。
   */
  userFeedbackOverride?: number;
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
  toolCalls?: Array<{ success: boolean; toolName?: string }>;
  errors?: Array<{ message: string }>;
  [key: string]: any;
}

/**
 * 提取任务完成度
 * 公式：1 - (errorCount / max(toolCallCount, 1)) * 0.5
 * 范围：[0, 1]
 */
export function extractTaskCompletion(metrics: SessionMetrics): number {
  // V1.0：无工具调用时该维度没有信息量，返回中性 0.75 而非满分。
  // 恒为 1.0 会形成天花板，把 user_feedback 的负信号稀释到无法触发阈值
  if (metrics.toolCallCount === 0) {
    return 0.75;
  }
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
  // V1.0：优先用外层注入的真实反馈信号（编辑/重发/打断推导）
  if (typeof metrics.userFeedbackOverride === 'number') {
    return Math.max(0, Math.min(1, metrics.userFeedbackOverride));
  }
  if (metrics.userInteractionCount === 0) {
    return 0.5; // 中性值
  }
  const interactionRate = metrics.userInteractionCount / Math.max(metrics.messageCount, 1);
  return Math.min(interactionRate, 1.0);
}

/**
 * 提取效率
 *
 * V1.0 口径（2026-09-05 后）：
 * - 改用工具调用成功率 + 轮次，而非墙钟时间/消息数
 * - 公式：基础分 0.7 + 成功率 * 0.3 - 过多轮次惩罚
 * - 无工具调用时返回中性值 0.7
 *
 * 旧口径问题：墙钟时间包含用户思考、模型吐字速度，与 Agent 表现无关
 */
export function extractEfficiency(metrics: SessionMetrics): number {
  const toolCallCount = metrics.toolCallCount;
  const errorCount = metrics.errorCount;

  // 无工具调用：返回中性值（大多数对话场景）
  if (toolCallCount === 0) {
    return 0.7;
  }

  // 成功率：0（全失败）→ 1（全成功）
  const successRate = (toolCallCount - errorCount) / toolCallCount;

  // 轮次惩罚：工具调用过多说明任务复杂或重试多
  // 5 次以内无惩罚，之后每多 5 次 -0.05
  const turnPenalty = Math.max(0, (toolCallCount - 5) / 5) * 0.05;

  // 基础 0.7 + 成功率贡献 0.3 - 轮次惩罚
  const efficiency = 0.7 + successRate * 0.3 - turnPenalty;

  return Math.max(0, Math.min(1, efficiency));
}

/**
 * 提取知识增长
 * 公式：min(knowledgeQueriesCount / max(messageCount, 1) * 2, 1.0)
 * 查询占比超过 50% 时返回 1.0
 *
 * V1.2 口径（2026-09-06 后）：
 * 无知识查询时返回中性 0.5，与其余三维「无信号 → 中性」口径一致，
 * 避免纯闲聊会话的知识增长维度恒为 0 并拖低 overall。
 * 有查询时以 0.5 为下界，保证随查询占比单调不减。
 */
export function extractKnowledgeGrowth(metrics: SessionMetrics): number {
  if (metrics.knowledgeQueriesCount === 0) {
    return 0.5;
  }
  const queryRate = metrics.knowledgeQueriesCount / Math.max(metrics.messageCount, 1);
  return Math.max(0.5, Math.min(queryRate * 2, 1.0));
}

/**
 * 知识查询工具分类器：读取/检索外部知识的工具调用计入 knowledge_growth，
 * 区别于写/改/编排类工具（bash、file_edit、file_write、spawn_agent 等）。
 */
const KNOWLEDGE_QUERY_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_read',
  'wiki_read',
  'wiki_search',
  'file_read',
  'glob',
  'grep',
  'list_dir',
])

/**
 * 从 Agent 会话收集指标
 */
/**
 * 由工具调用聚合出一行摘要：`file_read×3, grep×1`。
 *
 * **确定性输出**：按次数降序、同次数按名字升序——同一批工具调用每次得到同一个字符串，
 * 否则测试断言与日志对照都会飘。上限 200 字符（这是给人读的一行，不是数据）。
 *
 * 没有工具调用时返回 `undefined`：见 `SessionMetrics.taskDescription` 的注释。
 */
export function summarizeToolCalls(
  toolCalls: Array<{ toolName?: string }> | undefined,
): string | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined
  const counts = new Map<string, number>()
  for (const tc of toolCalls) {
    const name = tc.toolName?.trim()
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  if (counts.size === 0) return undefined
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
    .join(', ')
    .slice(0, 200)
}

export function collectMetricsFromSession(session: AgentSession): SessionMetrics {
  const messageCount = session.messages?.length || 0;
  const toolCallCount = session.toolCalls?.length || 0;
  const errorCount = session.errors?.length || 0;

  // 统计用户交互次数（用户消息数）
  const userInteractionCount = session.messages?.filter((msg: any) => msg.role === 'user').length || 0;

  // 统计知识查询次数（工具分类器：读取/检索类工具调用）
  const knowledgeQueriesCount = (session.toolCalls || []).filter(
    (tc) => tc.toolName != null && KNOWLEDGE_QUERY_TOOLS.has(tc.toolName),
  ).length;

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
    taskDescription: summarizeToolCalls(session.toolCalls),
    // 外层在会话快照上挂真实反馈分值时透传给 extractUserFeedback
    userFeedbackOverride:
      typeof session.userFeedbackOverride === 'number' ? session.userFeedbackOverride : undefined,
  };
}
