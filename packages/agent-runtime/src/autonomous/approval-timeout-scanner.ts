/**
 * 审批超时扫描器
 *
 * 定期扫描即将超时的审批请求，按类型应用超时策略。
 *
 * 来源：前端可视化实施方案.md 第十节 10.5
 */

import type { ApprovalQueue } from './approval-queue'
import type { AutonomousGoal } from './types'

/**
 * 目标获取接口
 */
export interface GoalRepository {
  getGoalById(goalId: string): Promise<AutonomousGoal | null>
}

/**
 * 审批超时扫描器
 */
export class ApprovalTimeoutScanner {
  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(
    private readonly queue: ApprovalQueue,
    private readonly goalRepo: GoalRepository,
    private readonly intervalMs: number = 15 * 60 * 1000 // 默认每 15 分钟
  ) {}

  /**
   * 启动扫描
   */
  start(): void {
    if (this.running) {
      return
    }

    this.running = true
    this.timer = setInterval(() => {
      this.scan().catch((error) => {
        console.error('[ApprovalTimeoutScanner] 扫描失败:', error)
      })
    }, this.intervalMs)

    console.log('[ApprovalTimeoutScanner] 已启动，扫描间隔:', this.intervalMs)
  }

  /**
   * 停止扫描
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.running = false
    console.log('[ApprovalTimeoutScanner] 已停止')
  }

  /**
   * 执行一次扫描
   */
  async scan(): Promise<void> {
    const approvals = await this.queue.scanExpiring()
    console.log(`[ApprovalTimeoutScanner] 扫描到 ${approvals.length} 条超时审批`)

    for (const approval of approvals) {
      try {
        // 获取目标信息
        const goal = await this.goalRepo.getGoalById(approval.goalId)
        if (!goal) {
          console.warn(`[ApprovalTimeoutScanner] 目标不存在: ${approval.goalId}`)
          continue
        }

        // 应用超时策略
        await this.queue.applyTimeoutPolicy(approval, goal)
        console.log(
          `[ApprovalTimeoutScanner] 已结算超时审批: ${approval.id}, 目标: ${goal.type}`
        )
      } catch (error) {
        console.error(`[ApprovalTimeoutScanner] 处理超时审批失败: ${approval.id}`, error)
      }
    }
  }
}
