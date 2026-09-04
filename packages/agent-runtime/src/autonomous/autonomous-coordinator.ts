/**
 * 自主协调器
 *
 * 事件驱动调度器，统一管理元认知引擎、目标生成器、Prompt 进化引擎和人格追踪器
 * 来源：设计文档 6-实施计划.md
 */

import { EventEmitter } from 'events';
import type { MVPScope, CoordinationMetrics, CoordinationEvent, AutonomousGoal, CapabilityDimension, CapabilityTest } from './types';
import type { AgentSession } from './metrics-collector';
import type { DatabaseClient } from './meta-cognition-engine';
import { MetaCognitionEngine, shouldTriggerGoalGeneration } from './meta-cognition-engine';
import { IntrinsicGoalGenerator, type GoalGenerationContext } from './intrinsic-goal-generator';
import { PromptEvolutionEngine } from './prompt-evolution';
import { PersonalityTracker, recordPersonalityEvent } from './personality-tracker';
import { CapabilityTracker } from './capability-tracker';
import { ReflectionEngine } from './reflection-engine';
import { createExtendedDbClient } from './db-adapter';
import { GoalStatus } from './types';
import { AUTONOMOUS_ENABLED, REFLECTION_SCHEDULE } from './config';

/**
 * 自主协调器
 */
export class AutonomousCoordinator extends EventEmitter {
  private initialized = false;
  private reflectionTimer?: ReturnType<typeof setTimeout>;
  private readonly capabilityTracker: CapabilityTracker;
  private readonly reflectionEngine?: ReflectionEngine;

  constructor(
    private readonly metaCognitionEngine: MetaCognitionEngine,
    private readonly goalGenerator: IntrinsicGoalGenerator,
    private readonly promptEvolution: PromptEvolutionEngine,
    private readonly personalityTracker: PersonalityTracker,
    private readonly config: MVPScope,
    private readonly db: DatabaseClient,
    capabilityTracker?: CapabilityTracker,
    reflectionEngine?: ReflectionEngine,
  ) {
    super();
    const extendedDb = createExtendedDbClient(db);
    this.capabilityTracker = capabilityTracker || new CapabilityTracker(extendedDb);
    this.reflectionEngine = reflectionEngine;
  }

  /**
   * 初始化协调器
   */
  async initialize(): Promise<void> {
    if (!AUTONOMOUS_ENABLED) {
      console.log('[AutonomousCoordinator] 自主能力已禁用');
      return;
    }

    // 注册事件监听器
    this.on('session:end', this.onSessionEnd.bind(this));
    this.on('satisfaction:low', this.onSatisfactionLow.bind(this));
    this.on('goal:generated', this.onGoalGenerated.bind(this));
    this.on('goal:approved', this.onGoalApproved.bind(this));
    this.on('evolution:completed', this.onEvolutionCompleted.bind(this));

    this.initialized = true;
    console.log('[AutonomousCoordinator] 初始化完成');
  }

  /**
   * 关闭协调器
   */
  async shutdown(): Promise<void> {
    this.removeAllListeners();
    this.initialized = false;
    console.log('[AutonomousCoordinator] 已关闭');
  }

  /**
   * 处理会话结束事件
   */
  async onSessionEnd(session: AgentSession): Promise<void> {
    try {
      // 计算满意度评分
      const score = await this.metaCognitionEngine.evaluateSession(session);

      // 记录 Telemetry
      this.logTelemetry({
        event: 'satisfaction-evaluated',
        sessionId: session.id,
        agentId: session.agentId,
        score: score.overall,
        dimensions: {
          task: score.taskCompletion,
          feedback: score.userFeedback,
          efficiency: score.efficiency,
          knowledge: score.knowledgeGrowth,
        },
        timestamp: new Date().toISOString(),
      });

      // 检查是否触发目标生成
      if (shouldTriggerGoalGeneration(score, this.metaCognitionEngine['config'].satisfactionThreshold)) {
        this.emit('satisfaction:low', score, {});
      }

      // 更新 Prompt 变体奖励（假设会话使用了某个变体）
      // 实际应从会话中获取 variantId
      // await this.promptEvolution.recordFeedback(variantId, score.overall);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[AutonomousCoordinator] 处理会话结束失败:', err.message);
    }
  }

  /**
   * 处理低满意度事件
   */
  async onSatisfactionLow(score: any, context: GoalGenerationContext): Promise<void> {
    try {
      // 生成目标
      const goals = await this.goalGenerator.generateGoals(score, context);

      // 记录 Telemetry
      this.logTelemetry({
        event: 'goals-generated',
        agentId: score.agentId,
        count: goals.length,
        types: goals.map((g) => g.type),
        timestamp: new Date().toISOString(),
      });

      // 触发目标生成事件
      for (const goal of goals) {
        this.emit('goal:generated', goal);

        // 记录人格事件
        const personalityEvent = await recordPersonalityEvent('goal-generated', goal.agentId, { goalId: goal.id, goalType: goal.type }, this.db);

        await this.personalityTracker.updatePersonality(goal.agentId, personalityEvent);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[AutonomousCoordinator] 处理低满意度失败:', err.message);
    }
  }

  /**
   * 处理目标生成事件
   */
  async onGoalGenerated(goal: AutonomousGoal): Promise<void> {
    try {
      // P0 阶段：所有目标需用户审批，此处仅记录
      console.log(`[AutonomousCoordinator] 目标已生成，等待用户审批: ${goal.description}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[AutonomousCoordinator] 处理目标生成失败:', err.message);
    }
  }

  /**
   * 处理目标批准事件
   */
  async onGoalApproved(goal: AutonomousGoal): Promise<void> {
    try {
      // 根据目标类型执行对应动作
      if (goal.type === 'learning') {
        // 学习型目标：选择最优 Prompt 变体
        // 实际应有具体的 baselinePromptId
        // const variant = await this.promptEvolution.selectPrompt(baselinePromptId);
        console.log(`[AutonomousCoordinator] 执行学习目标: ${goal.description}`);
      } else if (goal.type === 'proactive-message') {
        // 主动消息目标：生成消息内容（P0 阶段暂时占位）
        console.log(`[AutonomousCoordinator] 执行主动消息目标: ${goal.description}`);
      }

      // 记录 Telemetry
      this.logTelemetry({
        event: 'goal-executing',
        goalId: goal.id,
        agentId: goal.agentId,
        type: goal.type,
        timestamp: new Date().toISOString(),
      });

      // 更新目标状态
      await this.updateGoalStatus(goal.id, GoalStatus.EXECUTING);

      // 记录人格事件
      const personalityEvent = await recordPersonalityEvent('evolution-decided', goal.agentId, { goalId: goal.id, decision: 'execute' }, this.db);

      await this.personalityTracker.updatePersonality(goal.agentId, personalityEvent);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[AutonomousCoordinator] 处理目标批准失败:', err.message);
    }
  }

  /**
   * 处理进化完成事件
   */
  async onEvolutionCompleted(goalId: string, result: { success: boolean; satisfactionAfter?: number }): Promise<void> {
    try {
      // 更新目标状态
      const status = result.success ? GoalStatus.COMPLETED : GoalStatus.FAILED;
      await this.updateGoalStatus(goalId, status);

      // 如果成功，记录满意度提升
      if (result.success && result.satisfactionAfter !== undefined) {
        await this.updateGoalSatisfactionAfter(goalId, result.satisfactionAfter);
      }

      // 记录 Telemetry
      this.logTelemetry({
        event: 'evolution-completed',
        goalId,
        success: result.success,
        satisfactionAfter: result.satisfactionAfter,
        timestamp: new Date().toISOString(),
      });

      // 触发完成事件
      this.emit('evolution:completed', goalId, result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[AutonomousCoordinator] 处理进化完成失败:', err.message);
    }
  }

  /**
   * 获取协调指标
   */
  async getCoordinationMetrics(): Promise<CoordinationMetrics> {
    try {
      // 总评估次数
      const totalEvaluations = await this.db.query<any>(`SELECT COUNT(*) as count FROM autonomous_satisfaction_scores`, []);

      // 生成目标数（按类型分组）
      const goalsGenerated = await this.db.query<any>(`SELECT type, COUNT(*) as count FROM autonomous_goals GROUP BY type`, []);

      const goalsMap: Record<string, number> = {};
      for (const row of goalsGenerated) {
        goalsMap[row.type] = row.count;
      }

      // 审批率
      const approvalStats = await this.db.query<any>(`
        SELECT
          SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
          SUM(CASE WHEN status IN ('approved', 'rejected') THEN 1 ELSE 0 END) as total
        FROM autonomous_goals
      `, []);

      const approvalRate = approvalStats[0]?.total > 0 ? approvalStats[0].approved / approvalStats[0].total : 0;

      // 进化成功率（简化计算）
      const evolutionStats = await this.db.query<any>(`SELECT AVG(avg_satisfaction) as rate FROM prompt_variants`, []);

      const evolutionSuccessRate = evolutionStats[0]?.rate || 0;

      // 平均满意度提升
      const improvementStats = await this.db.query<any>(`
        SELECT AVG(satisfaction_after - satisfaction_before) as improvement
        FROM autonomous_goals
        WHERE satisfaction_after IS NOT NULL AND satisfaction_before IS NOT NULL
      `, []);

      const avgSatisfactionImprovement = improvementStats[0]?.improvement || 0;

      return {
        totalEvaluations: totalEvaluations[0]?.count || 0,
        goalsGenerated: goalsMap,
        approvalRate,
        evolutionSuccessRate,
        avgSatisfactionImprovement,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[AutonomousCoordinator] 获取协调指标失败:', err.message);
      return {
        totalEvaluations: 0,
        goalsGenerated: {},
        approvalRate: 0,
        evolutionSuccessRate: 0,
        avgSatisfactionImprovement: 0,
      };
    }
  }

  /**
   * 获取协调历史
   */
  async getCoordinationHistory(limit: number): Promise<CoordinationEvent[]> {
    try {
      const sql = `
        SELECT * FROM evolution_coordination_history
        ORDER BY created_at DESC
        LIMIT ?
      `;
      const rows = await this.db.query<any>(sql, [limit]);
      return rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        agentId: row.agent_id,
        goalId: row.goal_id,
        sessionId: row.session_id,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.created_at,
      }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[AutonomousCoordinator] 获取协调历史失败:', err.message);
      return [];
    }
  }

  /**
   * 记录 Telemetry（结构化日志）
   */
  private logTelemetry(data: Record<string, any>): void {
    console.log('[Telemetry]', JSON.stringify(data));
  }

  /**
   * 更新目标状态
   */
  private async updateGoalStatus(goalId: string, status: GoalStatus): Promise<void> {
    const sql = `UPDATE autonomous_goals SET status = ? WHERE id = ?`;
    await this.db.execute(sql, [status, goalId]);
  }

  /**
   * 更新目标执行后满意度
   */
  private async updateGoalSatisfactionAfter(goalId: string, satisfactionAfter: number): Promise<void> {
    const sql = `UPDATE autonomous_goals SET satisfaction_after = ? WHERE id = ?`;
    await this.db.execute(sql, [satisfactionAfter, goalId]);
  }
}
