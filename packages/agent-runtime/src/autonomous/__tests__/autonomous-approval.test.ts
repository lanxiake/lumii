/**
 * 自主进化核心功能测试
 *
 * 测试审批队列、风险分级、自动批准策略等核心功能。
 */

import { describe, it, expect } from 'vitest'
import { GoalType } from '../types'
import { classifyGoalRisk } from '../goal-risk-classifier'
import { shouldAutoApprove, AUTO_APPROVE_DAILY_CAP } from '../auto-approval-policy'
import { parseApprovalReply } from '../approval-reply-parser'
import { formatGoalApprovalPrompt } from '../approval-delivery'
import type { AutonomousGoal } from '../types'

describe('风险分级', () => {
  it('应该将学习目标分级为 internal', () => {
    const goal: AutonomousGoal = {
      id: 'test-1',
      agentId: 'agent-1',
      type: GoalType.LEARNING,
      description: '学习 TypeScript 最佳实践',
      triggerReason: 'low-satisfaction',
      status: 'pending' as any,
      priority: 0.8,
      createdAt: new Date().toISOString(),
    }

    const result = classifyGoalRisk(goal)
    expect(result.level).toBe('internal')
    expect(result.autoApprovable).toBe(true)
  })

  it('应该将主动消息分级为 user-visible', () => {
    const goal: AutonomousGoal = {
      id: 'test-2',
      agentId: 'agent-1',
      type: GoalType.PROACTIVE_MESSAGE,
      description: '每日早会议提醒',
      triggerReason: 'scheduled',
      status: 'pending' as any,
      priority: 0.6,
      createdAt: new Date().toISOString(),
    }

    const result = classifyGoalRisk(goal)
    expect(result.level).toBe('user-visible')
    expect(result.autoApprovable).toBe(false)
  })

  it('应该将技能增强分级为 side-effect', () => {
    const goal: AutonomousGoal = {
      id: 'test-3',
      agentId: 'agent-1',
      type: GoalType.SKILL_ENHANCEMENT,
      description: '优化代码生成技能',
      triggerReason: 'low-satisfaction',
      status: 'pending' as any,
      priority: 0.7,
      createdAt: new Date().toISOString(),
    }

    const result = classifyGoalRisk(goal)
    expect(result.level).toBe('side-effect')
    expect(result.autoApprovable).toBe(false)
  })

  it('应该检测到外部动作关键词并升级风险', () => {
    const goal: AutonomousGoal = {
      id: 'test-4',
      agentId: 'agent-1',
      type: GoalType.LEARNING,
      description: '学习后执行命令测试',
      triggerReason: 'scheduled',
      status: 'pending' as any,
      priority: 0.5,
      createdAt: new Date().toISOString(),
    }

    const result = classifyGoalRisk(goal)
    expect(result.level).toBe('side-effect')
    expect(result.reason).toContain('外部动作关键词')
  })
})

describe('自动批准策略', () => {
  it('应该自动批准 internal 目标', async () => {
    const goal: AutonomousGoal = {
      id: 'test-5',
      agentId: 'agent-1',
      type: GoalType.LEARNING,
      description: '学习 React Hooks',
      triggerReason: 'low-satisfaction',
      status: 'pending' as any,
      priority: 0.8,
      createdAt: new Date().toISOString(),
    }

    const mockDb = {
      getTodayAutoApprovalCount: async () => 0,
    }

    const result = await shouldAutoApprove(goal, mockDb)
    expect(result.shouldAutoApprove).toBe(true)
    expect(result.riskClassification.level).toBe('internal')
  })

  it('应该拒绝超过每日上限的自动批准', async () => {
    const goal: AutonomousGoal = {
      id: 'test-6',
      agentId: 'agent-1',
      type: GoalType.CAPABILITY_IMPROVEMENT,
      description: '提升文档分析能力',
      triggerReason: 'scheduled',
      status: 'pending' as any,
      priority: 0.7,
      createdAt: new Date().toISOString(),
    }

    const mockDb = {
      getTodayAutoApprovalCount: async () => AUTO_APPROVE_DAILY_CAP,
    }

    const result = await shouldAutoApprove(goal, mockDb)
    expect(result.shouldAutoApprove).toBe(false)
    expect(result.reason).toContain('已达到今日自动批准上限')
  })
})

describe('回复解析', () => {
  it('应该正确解析数字回复', () => {
    expect(parseApprovalReply('1')).toBe('approve')
    expect(parseApprovalReply('2')).toBe('reject')
    expect(parseApprovalReply('3')).toBe('always')
  })

  it('应该正确解析中文关键词', () => {
    expect(parseApprovalReply('同意')).toBe('approve')
    expect(parseApprovalReply('拒绝')).toBe('reject')
    expect(parseApprovalReply('好的')).toBe('approve')
    expect(parseApprovalReply('不同意')).toBe('reject')
  })

  it('应该对无法解析的输入返回 null', () => {
    expect(parseApprovalReply('你好')).toBe(null)
    expect(parseApprovalReply('帮我写代码')).toBe(null)
    expect(parseApprovalReply('')).toBe(null)
  })
})

describe('审批文案格式化', () => {
  it('应该生成正确的审批文案', () => {
    const goal: AutonomousGoal = {
      id: 'test-7',
      agentId: 'agent-1',
      type: GoalType.LEARNING,
      description: '学习用户常用的编程框架',
      triggerReason: 'low-satisfaction',
      status: 'pending' as any,
      priority: 0.8,
      createdAt: new Date().toISOString(),
    }

    const text = formatGoalApprovalPrompt(goal)
    expect(text).toContain('学习目标')
    expect(text).toContain('学习用户常用的编程框架')
    expect(text).toContain('回复 1 = 同意')
    expect(text).toContain('⭐⭐⭐⭐')
  })
})
