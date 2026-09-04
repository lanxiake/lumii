/**
 * 目标风险分级器
 *
 * 将自主目标按副作用范围分为三级：
 * - L0 internal: 只改 Agent 内部状态，可自动批准
 * - L1 user-visible: 对外可见（如主动消息），需审批
 * - L2 side-effect: 有副作用（文件写入、命令执行等），始终需人工审批
 *
 * 来源：前端可视化实施方案.md 第十节 10.3
 */

import type { AutonomousGoal } from './types'
import { GoalType } from './types'

/**
 * 目标风险等级
 */
export type GoalRiskLevel = 'internal' | 'user-visible' | 'side-effect'

/**
 * 风险分级结果
 */
export interface RiskClassification {
  level: GoalRiskLevel
  reason: string
  autoApprovable: boolean
}

/**
 * 外部动作关键词（任何包含这些词的目标都升级为 side-effect）
 */
const EXTERNAL_ACTION_PATTERNS = [
  '发送',
  '下载',
  '安装',
  '删除',
  '修改文件',
  '执行命令',
  '推送',
  '提交',
  '创建文件',
  '写入',
  '运行',
  '部署',
  '更新文件',
  '保存到',
]

/**
 * 目标风险分级
 *
 * 未知类型一律降级为最严格的 side-effect，避免新增类型默认被自动放行。
 *
 * @param goal 自主目标
 * @returns 风险分级结果
 */
export function classifyGoalRisk(goal: AutonomousGoal): RiskClassification {
  // 首先检查是否需要外部动作（关键词兜底）
  if (requiresExternalAction(goal)) {
    return {
      level: 'side-effect',
      reason: '目标描述中包含外部动作关键词',
      autoApprovable: false,
    }
  }

  // 根据目标类型分级
  switch (goal.type) {
    case GoalType.LEARNING:
      return {
        level: 'internal',
        reason: '纯内部学习，只更新知识库',
        autoApprovable: true,
      }

    case GoalType.CAPABILITY_IMPROVEMENT:
      return {
        level: 'internal',
        reason: '能力提升，只更新内部能力评估',
        autoApprovable: true,
      }

    case GoalType.MEMORY_OPTIMIZATION:
      return {
        level: 'internal',
        reason: '记忆优化，只调整排序权重',
        autoApprovable: true,
      }

    case GoalType.PROACTIVE_MESSAGE:
      return {
        level: 'user-visible',
        reason: '主动消息会打扰用户',
        autoApprovable: false,
      }

    case GoalType.SKILL_ENHANCEMENT:
      return {
        level: 'side-effect',
        reason: '技能增强可能涉及文件修改',
        autoApprovable: false,
      }

    default:
      // 未知类型，保守处理
      return {
        level: 'side-effect',
        reason: '未知目标类型，采用最严格策略',
        autoApprovable: false,
      }
  }
}

/**
 * 检查目标描述是否需要外部动作
 *
 * @param goal 自主目标
 * @returns 是否需要外部动作
 */
function requiresExternalAction(goal: AutonomousGoal): boolean {
  const description = goal.description.toLowerCase()
  return EXTERNAL_ACTION_PATTERNS.some((pattern) => description.includes(pattern.toLowerCase()))
}
