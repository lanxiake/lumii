/**
 * 自主进化审批流程集成示例
 *
 * 演示如何在 AutonomousCoordinator 中集成审批流程。
 */

import { randomUUID } from 'node:crypto'
import type { AutonomousGoal } from './types'
import { GoalType, GoalStatus } from './types'
import { classifyGoalRisk } from './goal-risk-classifier'
import { shouldAutoApprove } from './auto-approval-policy'
import { ApprovalQueue } from './approval-queue'
import { ApprovalDeliveryService } from './approval-delivery'
import { ApprovalTimeoutScanner } from './approval-timeout-scanner'
import { ApprovalDbAdapter } from './approval-db-adapter'
import type { DatabaseSync } from 'node:sqlite'

/**
 * 集成示例类（伪代码，展示集成流程）
 */
export class AutonomousApprovalIntegration {
  private approvalQueue: ApprovalQueue
  private deliveryService: ApprovalDeliveryService
  private timeoutScanner: ApprovalTimeoutScanner
  private db: ApprovalDbAdapter

  constructor(
    database: { db: DatabaseSync },
    channelRouter: any,
    settingsProvider: any,
    goalRepo: any
  ) {
    // 初始化数据库适配器
    this.db = new ApprovalDbAdapter(database)

    // 初始化审批队列
    this.approvalQueue = new ApprovalQueue(this.db)

    // 初始化送达服务
    this.deliveryService = new ApprovalDeliveryService(channelRouter, settingsProvider)

    // 初始化超时扫描器
    this.timeoutScanner = new ApprovalTimeoutScanner(
      this.approvalQueue,
      goalRepo,
      15 * 60 * 1000 // 每 15 分钟扫描一次
    )
  }

  /**
   * 启动审批系统
   */
  async start(): Promise<void> {
    this.timeoutScanner.start()
    console.log('[AutonomousApproval] 审批系统已启动')
  }

  /**
   * 停止审批系统
   */
  async stop(): Promise<void> {
    this.timeoutScanner.stop()
    console.log('[AutonomousApproval] 审批系统已停止')
  }

  /**
   * 处理新生成的目标
   *
   * 这是核心流程：
   * 1. 风险分级
   * 2. 判断是否自动批准
   * 3. 如果需要审批，创建审批记录并推送到渠道
   *
   * @param goal 新生成的目标
   * @param userId 用户 ID
   */
  async handleGoalGenerated(goal: AutonomousGoal, userId: string): Promise<void> {
    console.log(`[AutonomousApproval] 处理新目标: ${goal.id}, 类型: ${goal.type}`)

    // 1. 风险分级
    const classification = classifyGoalRisk(goal)
    console.log(
      `[AutonomousApproval] 风险分级: ${classification.level}, 原因: ${classification.reason}`
    )

    // 2. 判断是否自动批准
    const autoApproval = await shouldAutoApprove(goal, this.db)

    if (autoApproval.shouldAutoApprove) {
      // 自动批准
      console.log(`[AutonomousApproval] 自动批准目标: ${goal.id}`)

      // 创建审批记录（记录审计）
      const approval = await this.approvalQueue.createApproval(goal, classification.level)
      await this.approvalQueue.applyAutoPolicy(approval.id, autoApproval.reason)

      // 更新目标状态为已批准
      await this.updateGoalStatus(goal.id, GoalStatus.APPROVED)

      return
    }

    // 3. 需要人工审批
    console.log(`[AutonomousApproval] 需要人工审批: ${goal.id}`)

    // 创建审批记录
    const approval = await this.approvalQueue.createApproval(goal, classification.level)

    // 尝试推送到渠道
    try {
      const result = await this.deliveryService.deliver(approval, goal, userId)

      if (result.ok && result.target) {
        // 送达成功
        console.log(
          `[AutonomousApproval] 审批请求已送达: ${result.target.channel}/${result.target.peerId}`
        )
        await this.approvalQueue.markDelivered(
          approval.id,
          result.target.channel,
          result.target.peerId
        )
      } else {
        // 送达失败
        console.warn(
          `[AutonomousApproval] 审批请求送达失败: ${result.errorCode}, 将由超时策略接管`
        )
        await this.approvalQueue.markUnreachable(approval.id, result.errorCode!)
      }
    } catch (error) {
      console.error(`[AutonomousApproval] 推送审批请求异常:`, error)
      await this.approvalQueue.markUnreachable(approval.id, 'EXCEPTION')
    }
  }

  /**
   * 处理用户批准决策
   *
   * 当用户在前端点击批准按钮，或在渠道中回复"1"时调用。
   *
   * @param goalId 目标 ID
   * @param note 用户备注
   */
  async handleUserApprove(goalId: string, note?: string): Promise<void> {
    console.log(`[AutonomousApproval] 用户批准目标: ${goalId}`)

    // 查找审批记录
    const history = await this.db.getApprovalHistory(goalId)
    const pending = history.find((a) => a.status === 'pending')

    if (pending) {
      // 记录用户决策
      await this.approvalQueue.applyUserDecision(pending.id, 'approved', note)
    }

    // 更新目标状态
    await this.updateGoalStatus(goalId, GoalStatus.APPROVED)

    console.log(`[AutonomousApproval] 目标已批准，开始执行: ${goalId}`)
  }

  /**
   * 处理用户拒绝决策
   *
   * @param goalId 目标 ID
   * @param reason 拒绝原因
   */
  async handleUserReject(goalId: string, reason?: string): Promise<void> {
    console.log(`[AutonomousApproval] 用户拒绝目标: ${goalId}`)

    // 查找审批记录
    const history = await this.db.getApprovalHistory(goalId)
    const pending = history.find((a) => a.status === 'pending')

    if (pending) {
      // 记录用户决策
      await this.approvalQueue.applyUserDecision(pending.id, 'rejected', reason)
    }

    // 更新目标状态
    await this.updateGoalStatus(goalId, GoalStatus.REJECTED)

    console.log(`[AutonomousApproval] 目标已拒绝: ${goalId}`)
  }

  /**
   * 获取待审批目标列表
   */
  async getPendingApprovals(userId?: string): Promise<
    Array<{
      approval: any
      goal: AutonomousGoal
    }>
  > {
    const approvals = await this.approvalQueue.getPendingApprovals()

    // 这里需要关联查询目标信息
    // 实际实现中应该通过 JOIN 或批量查询
    const result = []
    for (const approval of approvals) {
      const goal = await this.getGoalById(approval.goalId)
      if (goal) {
        result.push({ approval, goal })
      }
    }

    return result
  }

  /**
   * 更新目标状态（伪代码，实际实现在 goal-generator 中）
   */
  private async updateGoalStatus(goalId: string, status: GoalStatus): Promise<void> {
    // 实际实现：更新数据库中的 autonomous_goals 表
    console.log(`[AutonomousApproval] 更新目标状态: ${goalId} -> ${status}`)
  }

  /**
   * 查询目标（伪代码）
   */
  private async getGoalById(goalId: string): Promise<AutonomousGoal | null> {
    // 实际实现：从数据库查询
    return null
  }
}

/**
 * 使用示例
 */
export async function exampleUsage() {
  // 1. 初始化（在 AutonomousCoordinator.initialize 中）
  const integration = new AutonomousApprovalIntegration(
    { db: {} as any }, // 数据库实例
    {} as any, // ChannelOutboundRouter 实例
    {} as any, // 设置提供者
    {} as any // 目标仓库
  )

  await integration.start()

  // 2. 当生成新目标时（在 IntrinsicGoalGenerator 中）
  const goal: AutonomousGoal = {
    id: randomUUID(),
    agentId: 'agent-1',
    type: GoalType.LEARNING,
    description: '学习 TypeScript 最佳实践',
    triggerReason: 'low-satisfaction',
    status: GoalStatus.PENDING,
    priority: 0.8,
    createdAt: new Date().toISOString(),
  }

  await integration.handleGoalGenerated(goal, 'user-1')

  // 3. 用户批准（在 IPC 处理器中）
  await integration.handleUserApprove(goal.id, '看起来不错')

  // 4. 清理（在 shutdown 中）
  await integration.stop()
}
