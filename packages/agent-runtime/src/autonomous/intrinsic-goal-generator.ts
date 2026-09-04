/**
 * 内在目标生成器
 *
 * 根据满意度评分生成学习型目标和主动消息目标
 * 来源：设计文档 3-内在目标生成器.md
 */

import type { SatisfactionScore, AutonomousGoal, GoalType, GoalStatus, GoalGenerationConfig, CapabilityGap, CapabilityDimension } from './types';
import type { SessionMetrics } from './metrics-collector';
import type { DatabaseClient } from './meta-cognition-engine';
import { GoalType as GoalTypeEnum, GoalStatus as GoalStatusEnum } from './types';

/**
 * 目标生成上下文
 */
export interface GoalGenerationContext {
  /** 最近会话历史 */
  recentHistory?: SessionMetrics[];
  /** 用户上次消息时间 */
  lastUserMessageTime?: Date;
  /** 能力缺口列表（P1 新增）*/
  capabilityGaps?: CapabilityGap[];
  /** 技能缺口列表（P2 新增）*/
  skillGaps?: SkillGapInput[];
  /** 低效记忆 ID 列表（P2 新增）*/
  ineffectiveMemoryIds?: string[];
  /** 其他上下文数据 */
  [key: string]: any;
}

/**
 * 技能缺口输入（P2）
 * 与 SkillEvolution.identifySkillGaps 的输出结构对齐
 */
export interface SkillGapInput {
  skillName: string;
  issue: 'low-success-rate' | 'low-satisfaction' | 'high-execution-time';
  priority: number;
  currentValue: number;
  threshold: number;
}

/**
 * 生成学习型目标（纯函数）
 *
 * @param score 满意度评分
 * @param recentHistory 最近会话历史
 * @returns 学习型目标或 null
 */
export function generateLearningGoal(score: SatisfactionScore, recentHistory: SessionMetrics[] = []): AutonomousGoal | null {
  // 找出最低的满意度维度
  const dimensions = {
    task: score.taskCompletion,
    feedback: score.userFeedback,
    efficiency: score.efficiency,
    knowledge: score.knowledgeGrowth,
  };

  const lowestDimension = Object.entries(dimensions).reduce((min, [key, value]) => (value < min.value ? { key, value } : min), { key: 'task', value: 1.0 });

  // 生成目标描述
  const descriptions: Record<string, string> = {
    task: '提升任务完成度：学习更有效的工具使用策略',
    feedback: '改善用户反馈质量：学习更好的交互模式',
    efficiency: '提升工作效率：优化响应速度和资源使用',
    knowledge: '增强知识积累：主动学习相关领域知识',
  };

  const description = descriptions[lowestDimension.key];

  // 计算优先级：综合考虑总体满意度和最低维度
  const priority = (1 - score.overall) * 0.7 + (1 - lowestDimension.value) * 0.3;

  return {
    id: '', // 由调用方生成 UUID
    agentId: score.agentId,
    type: GoalTypeEnum.LEARNING,
    description,
    triggerReason: 'low-satisfaction',
    status: GoalStatusEnum.PENDING,
    priority: Math.max(0, Math.min(1, priority)),
    satisfactionBefore: score.overall,
    metadata: {
      lowestDimension: lowestDimension.key,
      lowestDimensionScore: lowestDimension.value,
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * 生成主动消息目标（纯函数）
 *
 * @param score 满意度评分
 * @param context 上下文
 * @returns 主动消息目标或 null
 */
export function generateProactiveMessageGoal(score: SatisfactionScore, context: { lastUserMessageTime?: Date }): AutonomousGoal | null {
  const now = new Date();
  const lastMessageTime = context.lastUserMessageTime || now;
  const timeSinceLastMessage = (now.getTime() - lastMessageTime.getTime()) / 1000; // 秒

  // 阈值：6 小时 = 21600 秒
  const threshold = 6 * 3600;

  // 满意度中等或高，且用户长时间无交互
  if (score.overall >= 0.6 && timeSinceLastMessage > threshold) {
    // 计算优先级：综合满意度和时间间隔
    const timeFactor = Math.min(timeSinceLastMessage / 86400, 1.0); // 归一化到 [0, 1]
    const priority = score.overall * 0.5 + timeFactor * 0.5;

    return {
      id: '',
      agentId: score.agentId,
      type: GoalTypeEnum.PROACTIVE_MESSAGE,
      description: '主动向用户汇报学习进展和能力提升',
      triggerReason: 'scheduled',
      status: GoalStatusEnum.PENDING,
      priority: Math.max(0, Math.min(1, priority)),
      satisfactionBefore: score.overall,
      metadata: {
        timeSinceLastMessage,
        satisfactionLevel: score.overall >= 0.8 ? 'high' : 'medium',
      },
      createdAt: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * 能力维度到中文名称的映射
 */
const CAPABILITY_DIMENSION_NAMES: Record<string, string> = {
  code_generation: '代码生成',
  document_analysis: '文档分析',
  web_search: '网络搜索',
  data_processing: '数据处理',
  api_integration: 'API 集成',
  creative_writing: '创意写作',
  logical_reasoning: '逻辑推理',
  multi_step_planning: '多步规划',
};

/**
 * 生成能力改进目标（纯函数）
 *
 * @param gaps 能力缺口列表（按优先级排序）
 * @param agentId Agent ID
 * @returns 能力改进目标或 null
 */
export function generateCapabilityImprovementGoal(
  gaps: CapabilityGap[],
  agentId: string
): AutonomousGoal | null {
  if (gaps.length === 0) {
    return null;
  }

  // 选择优先级最高的缺口
  const topGap = gaps[0];

  // 构造目标描述
  const dimensionName = CAPABILITY_DIMENSION_NAMES[topGap.dimension] || topGap.dimension;
  const description = `提升${dimensionName}能力：从当前水平 ${(topGap.currentLevel * 100).toFixed(0)}% 提升到目标水平 ${(topGap.desiredLevel * 100).toFixed(0)}%`;

  return {
    id: '',
    agentId,
    type: GoalTypeEnum.CAPABILITY_IMPROVEMENT,
    description,
    triggerReason: 'low-satisfaction',
    status: GoalStatusEnum.PENDING,
    priority: topGap.priority,
    metadata: {
      dimension: topGap.dimension,
      currentLevel: topGap.currentLevel,
      desiredLevel: topGap.desiredLevel,
      gap: topGap.gap,
      demandFrequency: topGap.demandFrequency,
    },
    createdAt: new Date().toISOString(),
  };
}

/** 技能缺口类型的中文说明（P2） */
const SKILL_ISSUE_NAMES: Record<SkillGapInput['issue'], string> = {
  'low-success-rate': '成功率较低',
  'low-satisfaction': '用户满意度不足',
  'high-execution-time': '执行时间过长',
};

/**
 * P2: 生成技能改进目标（纯函数）
 *
 * 只输出待批准的改进候选，不自动生成、安装或执行任何技能代码。
 *
 * @param gaps 技能缺口列表（按优先级排序）
 * @param agentId Agent ID
 * @returns 技能改进目标或 null
 */
export function generateSkillEnhancementGoal(gaps: SkillGapInput[], agentId: string): AutonomousGoal | null {
  if (gaps.length === 0) {
    return null;
  }

  const topGap = gaps[0];
  const issueName = SKILL_ISSUE_NAMES[topGap.issue] || topGap.issue;
  const description = `改进技能"${topGap.skillName}"：${issueName}`;

  return {
    id: '',
    agentId,
    type: GoalTypeEnum.SKILL_ENHANCEMENT,
    description,
    triggerReason: 'low-satisfaction',
    status: GoalStatusEnum.PENDING,
    // 优先级归一化到 [0, 1]，缺口优先级是无界的原始分值
    priority: Math.max(0, Math.min(1, topGap.priority)),
    metadata: {
      skillName: topGap.skillName,
      issue: topGap.issue,
      currentValue: topGap.currentValue,
      threshold: topGap.threshold,
      rawPriority: topGap.priority,
      /** 明确标记：需要用户批准后才可执行任何改动 */
      requiresApproval: true,
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * P2: 生成记忆优化目标（纯函数）
 *
 * 只提出"标记并复核低效记忆"的目标；P2 不自动删除任何记忆。
 *
 * @param ineffectiveMemoryIds 低效记忆 ID 列表
 * @param agentId Agent ID
 * @returns 记忆优化目标或 null
 */
export function generateMemoryOptimizationGoal(ineffectiveMemoryIds: string[], agentId: string): AutonomousGoal | null {
  if (ineffectiveMemoryIds.length === 0) {
    return null;
  }

  const count = ineffectiveMemoryIds.length;
  const description = `复核 ${count} 条低效记忆：这些记忆的历史贡献度持续偏低，建议确认是否保留`;

  // 低效记忆越多，优先级越高；20 条以上到达上限
  const priority = Math.max(0, Math.min(1, count / 20));

  return {
    id: '',
    agentId,
    type: GoalTypeEnum.MEMORY_OPTIMIZATION,
    description,
    triggerReason: 'scheduled',
    status: GoalStatusEnum.PENDING,
    priority,
    metadata: {
      ineffectiveMemoryCount: count,
      // 只保存 ID，不保存记忆内容
      memoryIds: ineffectiveMemoryIds.slice(0, 50),
      /** P2 只标记不删除，删除必须显式批准 */
      action: 'review-only',
      requiresApproval: true,
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * 内在目标生成器
 */
export class IntrinsicGoalGenerator {
  constructor(
    private readonly config: GoalGenerationConfig,
    private readonly db: DatabaseClient,
  ) {}

  /**
   * 生成目标
   *
   * @param score 满意度评分
   * @param context 生成上下文
   * @returns 生成的目标列表
   */
  async generateGoals(score: SatisfactionScore, context: GoalGenerationContext = {}): Promise<AutonomousGoal[]> {
    try {
      // 检查今日已生成目标数
      const todayCount = await this.getTodayGoalCount(score.agentId);
      if (todayCount >= this.config.maxGoalsPerDay) {
        console.log(`[IntrinsicGoalGenerator] 已达到每日目标上限 ${this.config.maxGoalsPerDay}`);
        return [];
      }

      const goals: AutonomousGoal[] = [];

      // 根据启用的目标类型生成
      for (const type of this.config.enabledTypes) {
        if (type === GoalTypeEnum.LEARNING) {
          const goal = generateLearningGoal(score, context.recentHistory);
          if (goal) goals.push(goal);
        } else if (type === GoalTypeEnum.PROACTIVE_MESSAGE) {
          const goal = generateProactiveMessageGoal(score, context);
          if (goal) goals.push(goal);
        } else if (type === GoalTypeEnum.CAPABILITY_IMPROVEMENT) {
          // P1 新增：能力改进目标
          if (context.capabilityGaps && context.capabilityGaps.length > 0) {
            const goal = generateCapabilityImprovementGoal(context.capabilityGaps, score.agentId);
            if (goal) goals.push(goal);
          }
        } else if (type === GoalTypeEnum.SKILL_ENHANCEMENT) {
          // P2 新增：技能改进目标
          if (context.skillGaps && context.skillGaps.length > 0) {
            const goal = generateSkillEnhancementGoal(context.skillGaps, score.agentId);
            if (goal) goals.push(goal);
          }
        } else if (type === GoalTypeEnum.MEMORY_OPTIMIZATION) {
          // P2 新增：记忆优化目标
          if (context.ineffectiveMemoryIds && context.ineffectiveMemoryIds.length > 0) {
            const goal = generateMemoryOptimizationGoal(context.ineffectiveMemoryIds, score.agentId);
            if (goal) goals.push(goal);
          }
        }
      }

      // 按优先级排序
      goals.sort((a, b) => b.priority - a.priority);

      // P2: 与已存在的未完成目标去重，避免新来源重复生成同一目标
      const deduped = await this.deduplicateGoals(score.agentId, goals);

      // 限制不超过剩余配额（全局每日上限对所有来源统一生效）
      const remaining = this.config.maxGoalsPerDay - todayCount;
      const goalsToCreate = deduped.slice(0, remaining);

      // 持久化到数据库
      for (const goal of goalsToCreate) {
        await this.saveGoal(goal);
      }

      return goalsToCreate;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[IntrinsicGoalGenerator] 生成目标失败:', err.message);
      return [];
    }
  }

  /**
   * 批准目标
   */
  async approveGoal(goalId: string): Promise<void> {
    const sql = `
      UPDATE autonomous_goals
      SET status = ?, approved_at = ?
      WHERE id = ?
    `;
    await this.db.execute(sql, [GoalStatusEnum.APPROVED, new Date().toISOString(), goalId]);
  }

  /**
   * 拒绝目标
   */
  async rejectGoal(goalId: string): Promise<void> {
    const sql = `
      UPDATE autonomous_goals
      SET status = ?
      WHERE id = ?
    `;
    await this.db.execute(sql, [GoalStatusEnum.REJECTED, goalId]);
  }

  /**
   * 获取待审批目标
   */
  async getPendingGoals(agentId: string): Promise<AutonomousGoal[]> {
    const sql = `
      SELECT * FROM autonomous_goals
      WHERE agent_id = ? AND status = ?
      ORDER BY priority DESC, created_at DESC
    `;
    const rows = await this.db.query<any>(sql, [agentId, GoalStatusEnum.PENDING]);
    return rows.map(this.mapRowToGoal);
  }

  /**
   * P2: 与已存在的未完成目标去重
   *
   * 同类型 + 同描述的目标若已处于 pending/approved/executing，则本次不再生成。
   * 同时对本批次内部去重。
   */
  private async deduplicateGoals(agentId: string, goals: AutonomousGoal[]): Promise<AutonomousGoal[]> {
    if (goals.length === 0) {
      return goals;
    }

    try {
      const sql = `
        SELECT type, description FROM autonomous_goals
        WHERE agent_id = ? AND status IN (?, ?, ?)
      `;
      const rows = await this.db.query<any>(sql, [
        agentId,
        GoalStatusEnum.PENDING,
        GoalStatusEnum.APPROVED,
        GoalStatusEnum.EXECUTING,
      ]);

      const seen = new Set<string>(rows.map((row) => `${row.type}::${row.description}`));
      const result: AutonomousGoal[] = [];

      for (const goal of goals) {
        const key = `${goal.type}::${goal.description}`;
        if (seen.has(key)) {
          console.log(`[IntrinsicGoalGenerator] 跳过重复目标: ${key}`);
          continue;
        }
        seen.add(key);
        result.push(goal);
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[IntrinsicGoalGenerator] 目标去重失败，仅做批次内去重:', err.message);

      // 降级：只在本批次内部去重
      const seen = new Set<string>();
      return goals.filter((goal) => {
        const key = `${goal.type}::${goal.description}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }

  /**
   * 获取今日已生成目标数
   */
  private async getTodayGoalCount(agentId: string): Promise<number> {
    const sql = `
      SELECT COUNT(*) as count
      FROM autonomous_goals
      WHERE agent_id = ?
        AND created_at >= date('now')
        AND status IN (?, ?, ?)
    `;
    const rows = await this.db.query<any>(sql, [agentId, GoalStatusEnum.PENDING, GoalStatusEnum.APPROVED, GoalStatusEnum.EXECUTING]);
    return rows[0]?.count || 0;
  }

  /**
   * 保存目标到数据库
   */
  private async saveGoal(goal: AutonomousGoal): Promise<void> {
    const id = this.generateId();
    const sql = `
      INSERT INTO autonomous_goals (
        id, agent_id, type, description, trigger_reason,
        status, priority, satisfaction_before, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await this.db.execute(sql, [id, goal.agentId, goal.type, goal.description, goal.triggerReason, goal.status, goal.priority, goal.satisfactionBefore, JSON.stringify(goal.metadata || {}), goal.createdAt]);

    goal.id = id;
  }

  /**
   * 映射数据库行到目标对象
   */
  private mapRowToGoal(row: any): AutonomousGoal {
    return {
      id: row.id,
      agentId: row.agent_id,
      type: row.type,
      description: row.description,
      triggerReason: row.trigger_reason,
      status: row.status,
      priority: row.priority,
      satisfactionBefore: row.satisfaction_before,
      satisfactionAfter: row.satisfaction_after,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      approvedAt: row.approved_at,
      executedAt: row.executed_at,
      completedAt: row.completed_at,
    };
  }

  /**
   * 生成 UUID（简化版）
   */
  private generateId(): string {
    return `goal_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
