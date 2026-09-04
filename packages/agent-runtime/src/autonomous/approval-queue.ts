/**
 * 审批队列管理器
 *
 * 管理自主目标的审批流程，包括：
 * - 创建审批请求
 * - 查询待审批项
 * - 更新送达状态
 * - 记录决策结果
 *
 * 来源：前端可视化实施方案.md 第十节 10.4
 */

import { randomUUID } from 'node:crypto'
import type { AutonomousGoal, GoalType } from './types'
import type { GoalRiskLevel } from './goal-risk-classifier'

/**
 * 审批记录状态
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/**
 * 送达状态
 */
export type DeliveryStatus = 'sent' | 'failed' | 'unreachable'

/**
 * 决策来源
 */
export type DecisionSource = 'user' | 'auto-policy' | 'timeout-policy'

/**
 * 审批记录
 */
export interface ApprovalRecord {
  id: string
  goalId: string
  riskLevel: GoalRiskLevel
  status: ApprovalStatus
  // 送达
  channel?: string
  peerId?: string
  deliveryStatus?: DeliveryStatus
  deliveryError?: string
  deliveredAt?: number
  // 决策
  decidedBy?: DecisionSource
  decidedAt?: number
  decisionNote?: string
  // 超时
  expiresAt: number
  createdAt: number
}

/**
 * 审批队列数据库接口
 */
export interface ApprovalDatabase {
  /**
   * 创建审批记录
   */
  createApproval(record: ApprovalRecord): Promise<void>

  /**
   * 查询待审批项（按 peerId 筛选）
   */
  findPendingApprovals(peerId?: string): Promise<ApprovalRecord[]>

  /**
   * 查询最近一条待审批项（用于回复匹配）
   */
  findLatestPendingApproval(peerId: string): Promise<ApprovalRecord | null>

  /**
   * 查询即将超时的审批（用于超时扫描）
   */
  findExpiringApprovals(beforeTimestamp: number): Promise<ApprovalRecord[]>

  /**
   * 更新送达状态
   */
  updateDeliveryStatus(
    approvalId: string,
    status: DeliveryStatus,
    channel?: string,
    peerId?: string,
    error?: string
  ): Promise<void>

  /**
   * 记录决策
   */
  recordDecision(
    approvalId: string,
    decision: ApprovalStatus,
    decidedBy: DecisionSource,
    note?: string
  ): Promise<void>

  /**
   * 查询今日自动批准数量
   */
  getTodayAutoApprovalCount(agentId: string): Promise<number>

  /**
   * 查询审批记录（含过期记录，用于审计）
   */
  getApprovalHistory(goalId: string): Promise<ApprovalRecord[]>
}

/**
 * 超时策略配置
 */
export interface TimeoutPolicy {
  ttlMs: number
  onTimeout: ApprovalStatus
}

/**
 * 各类型目标的超时策略
 *
 * - learning/capability-improvement/memory-optimization: 4h 超时 → 批准（做了无风险）
 * - proactive-message: 2h 超时 → 拒绝（过期的主动消息是骚扰）
 * - skill-enhancement: 24h 超时 → 归档（有副作用，绝不自动批准）
 */
export const TIMEOUT_POLICIES: Record<GoalType, TimeoutPolicy> = {
  learning: { ttlMs: 4 * 3600_000, onTimeout: 'approved' },
  'proactive-message': { ttlMs: 2 * 3600_000, onTimeout: 'rejected' },
  'capability-improvement': { ttlMs: 4 * 3600_000, onTimeout: 'approved' },
  'skill-enhancement': { ttlMs: 24 * 3600_000, onTimeout: 'expired' },
  'memory-optimization': { ttlMs: 4 * 3600_000, onTimeout: 'approved' },
}

/**
 * 审批队列管理器
 */
export class ApprovalQueue {
  constructor(private readonly db: ApprovalDatabase) {}

  /**
   * 创建审批请求
   *
   * @param goal 自主目标
   * @param riskLevel 风险等级
   * @returns 审批记录
   */
  async createApproval(goal: AutonomousGoal, riskLevel: GoalRiskLevel): Promise<ApprovalRecord> {
    const policy = TIMEOUT_POLICIES[goal.type]
    const now = Date.now()

    const record: ApprovalRecord = {
      id: randomUUID(),
      goalId: goal.id,
      riskLevel,
      status: 'pending',
      expiresAt: now + policy.ttlMs,
      createdAt: now,
    }

    await this.db.createApproval(record)
    return record
  }

  /**
   * 查询待审批项
   */
  async getPendingApprovals(peerId?: string): Promise<ApprovalRecord[]> {
    return this.db.findPendingApprovals(peerId)
  }

  /**
   * 标记为已送达
   */
  async markDelivered(
    approvalId: string,
    channel: string,
    peerId: string
  ): Promise<void> {
    await this.db.updateDeliveryStatus(
      approvalId,
      'sent',
      channel,
      peerId
    )
  }

  /**
   * 标记为送达失败
   */
  async markFailed(
    approvalId: string,
    errorCode: string
  ): Promise<void> {
    await this.db.updateDeliveryStatus(
      approvalId,
      'failed',
      undefined,
      undefined,
      errorCode
    )
  }

  /**
   * 标记为不可达（无渠道）
   */
  async markUnreachable(
    approvalId: string,
    errorCode: string
  ): Promise<void> {
    await this.db.updateDeliveryStatus(
      approvalId,
      'unreachable',
      undefined,
      undefined,
      errorCode
    )
  }

  /**
   * 应用用户决策
   */
  async applyUserDecision(
    approvalId: string,
    decision: 'approved' | 'rejected',
    note?: string
  ): Promise<void> {
    await this.db.recordDecision(approvalId, decision, 'user', note)
  }

  /**
   * 应用自动批准策略
   */
  async applyAutoPolicy(
    approvalId: string,
    note: string
  ): Promise<void> {
    await this.db.recordDecision(approvalId, 'approved', 'auto-policy', note)
  }

  /**
   * 应用超时策略
   */
  async applyTimeoutPolicy(
    approval: ApprovalRecord,
    goal: AutonomousGoal
  ): Promise<void> {
    const action = this.resolveTimeoutAction(approval, goal)
    await this.db.recordDecision(
      approval.id,
      action,
      'timeout-policy',
      `超时：${goal.type} 类型超时策略`
    )
  }

  /**
   * 解析超时动作
   *
   * 送达失败时收紧策略：
   * 用户根本没收到请求，不能当作「默示同意」处理有对外影响的目标。
   */
  private resolveTimeoutAction(
    approval: ApprovalRecord,
    goal: AutonomousGoal
  ): ApprovalStatus {
    const policy = TIMEOUT_POLICIES[goal.type]

    // 从未送达 → 只允许 L0 内部目标按 approve 走，其余一律 expire
    if (approval.deliveryStatus !== 'sent') {
      return approval.riskLevel === 'internal' ? policy.onTimeout : 'expired'
    }

    return policy.onTimeout
  }

  /**
   * 扫描即将超时的审批（供定时任务调用）
   */
  async scanExpiring(): Promise<ApprovalRecord[]> {
    const now = Date.now()
    return this.db.findExpiringApprovals(now)
  }
}
