/**
 * 自动审批策略
 *
 * 管理 L0 内部目标的自动批准逻辑，包括：
 * - 总开关控制
 * - 每日上限
 * - 审计记录
 *
 * 来源：前端可视化实施方案.md 第十节 10.3
 */

import type { AutonomousGoal } from './types'
import type { RiskClassification } from './goal-risk-classifier'
import { classifyGoalRisk } from './goal-risk-classifier'

/**
 * L0 内部目标是否自动批准（默认开启，可关闭回退到全人工）
 */
export const AUTO_APPROVE_INTERNAL_GOALS =
  process.env.AUTONOMOUS_AUTO_APPROVE_INTERNAL !== 'false'

/**
 * 自动批准的每日上限，防止异常放大
 */
export const AUTO_APPROVE_DAILY_CAP = parseInt(
  process.env.AUTONOMOUS_AUTO_APPROVE_DAILY_CAP || '5',
  10
)

/**
 * 自动批准决策结果
 */
export interface AutoApprovalDecision {
  /** 是否应该自动批准 */
  shouldAutoApprove: boolean
  /** 决策原因 */
  reason: string
  /** 风险分级 */
  riskClassification: RiskClassification
  /** 当前已自动批准数量 */
  todayCount?: number
}

/**
 * 数据库接口（用于查询今日自动批准数量）
 */
export interface AutoApprovalDatabase {
  getTodayAutoApprovalCount(agentId: string): Promise<number>
}

/**
 * 判断目标是否应该自动批准
 *
 * @param goal 自主目标
 * @param db 数据库接口
 * @returns 自动批准决策
 */
export async function shouldAutoApprove(
  goal: AutonomousGoal,
  db: AutoApprovalDatabase
): Promise<AutoApprovalDecision> {
  // 检查总开关
  if (!AUTO_APPROVE_INTERNAL_GOALS) {
    return {
      shouldAutoApprove: false,
      reason: '自动批准功能已关闭',
      riskClassification: classifyGoalRisk(goal),
    }
  }

  // 风险分级
  const riskClassification = classifyGoalRisk(goal)

  // 只有 L0 内部目标才可能自动批准
  if (!riskClassification.autoApprovable) {
    return {
      shouldAutoApprove: false,
      reason: `风险等级 ${riskClassification.level} 不允许自动批准`,
      riskClassification,
    }
  }

  // 检查每日上限
  const todayCount = await db.getTodayAutoApprovalCount(goal.agentId)
  if (todayCount >= AUTO_APPROVE_DAILY_CAP) {
    return {
      shouldAutoApprove: false,
      reason: `已达到今日自动批准上限 (${todayCount}/${AUTO_APPROVE_DAILY_CAP})`,
      riskClassification,
      todayCount,
    }
  }

  // 通过所有检查，可以自动批准
  return {
    shouldAutoApprove: true,
    reason: 'L0 内部目标，自动批准',
    riskClassification,
    todayCount,
  }
}
