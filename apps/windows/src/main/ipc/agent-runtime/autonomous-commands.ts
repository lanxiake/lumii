/**
 * 自主进化命令处理器
 *
 * 数据源为 agent-runtime.db 中 V28-V31 迁移建立的正式表，
 * 全部经 bridge.autonomousRepo 访问，不自建库、不落演示数据。
 *
 * 开关状态存 runtime_state，键 autonomous.enabled；缺省视为启用。
 */

import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import { notifyAutonomousGoalApproved } from '../../agent-runtime/autonomous-wiring'

const ENABLED_KEY = 'autonomous.enabled'
const DEFAULT_AGENT_ID = 'assistant'

/** 解析目标 agentId：显式优先，其次按会话归属，最后落默认助手 */
function resolveAgentId(
  bridge: AgentRuntimeBridge,
  sessionKey?: string,
  explicitAgentId?: string,
): string {
  if (explicitAgentId) return explicitAgentId
  if (sessionKey) {
    const fromConv = bridge.conversationRepo.getAgentParticipantId(sessionKey)
    if (fromConv) return fromConv
  }
  return DEFAULT_AGENT_ID
}

/** 读取开关：未写过配置时默认启用 */
function readEnabled(bridge: AgentRuntimeBridge): boolean {
  return bridge.runtimeStateRepo.get(ENABLED_KEY) !== 'false'
}

/** 由前后两点满意度判定趋势；样本不足按 stable 处理 */
function deriveTrend(history: { overall_score: number }[]): 'improving' | 'stable' | 'declining' {
  if (history.length < 2) return 'stable'
  const first = history[0].overall_score
  const last = history[history.length - 1].overall_score
  const delta = last - first
  if (delta > 0.02) return 'improving'
  if (delta < -0.02) return 'declining'
  return 'stable'
}

function windowStart(window: string): string {
  const now = new Date()
  if (window === '30d') {
    now.setDate(now.getDate() - 30)
    return now.toISOString()
  }
  if (window === 'all') return new Date(0).toISOString()
  now.setDate(now.getDate() - 7)
  return now.toISOString()
}

export function handleAutonomousStatus(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'autonomous:status' }>,
): unknown {
  const agentId = resolveAgentId(bridge, command.sessionKey, command.agentId)
  const latest = bridge.autonomousRepo.latestSatisfaction(agentId)
  const recent = bridge.autonomousRepo.satisfactionHistory(agentId, windowStart('7d'))
  const pendingGoalsCount = bridge.autonomousRepo.countGoalsByStatus(agentId, 'pending')
  const enabled = readEnabled(bridge)

  if (!latest) {
    return {
      enabled,
      agentId,
      satisfaction: null,
      pendingGoalsCount,
      hasData: false,
    }
  }

  return {
    enabled,
    agentId,
    satisfaction: {
      overall: latest.overall_score,
      trend: deriveTrend(recent),
      breakdown: {
        taskCompletion: latest.task_completion,
        userFeedback: latest.user_feedback,
        efficiency: latest.efficiency,
        knowledgeGrowth: latest.knowledge_growth,
      },
      lastUpdated: latest.created_at,
    },
    pendingGoalsCount,
    hasData: true,
  }
}

export function handleAutonomousGoalsList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'autonomous:goals:list' }>,
): unknown {
  const agentId = resolveAgentId(bridge, command.sessionKey, command.agentId)
  const goals = bridge.autonomousRepo.listGoals(agentId, command.status)
  return {
    goals: goals.map((g) => ({
      id: g.id,
      type: g.type,
      description: g.description,
      triggerReason: g.trigger_reason,
      status: g.status,
      priority: g.priority,
      createdAt: g.created_at,
      approvedAt: g.approved_at,
    })),
    total: goals.length,
  }
}

export function handleAutonomousGoalsApprove(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'autonomous:goals:approve' }>,
): unknown {
  if (!command.goalId) throw new Error('autonomous:goals:approve 需要 goalId')
  const updated = bridge.autonomousRepo.approveGoal(command.goalId, command.note)
  if (!updated) {
    return { success: false, goalId: command.goalId, reason: '目标不存在或不处于 pending 状态' }
  }
  // 审批成功后通知协调器，让目标流转到 executing 并记录进化人格事件
  notifyAutonomousGoalApproved(command.goalId)
  return { success: true, goalId: command.goalId, status: 'approved' }
}

export function handleAutonomousGoalsReject(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'autonomous:goals:reject' }>,
): unknown {
  if (!command.goalId) throw new Error('autonomous:goals:reject 需要 goalId')
  const updated = bridge.autonomousRepo.rejectGoal(command.goalId, command.reason)
  if (!updated) {
    return { success: false, goalId: command.goalId, reason: '目标不存在或不处于 pending 状态' }
  }
  return { success: true, goalId: command.goalId, status: 'rejected' }
}

export function handleAutonomousCapabilities(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'autonomous:capabilities' }>,
): unknown {
  const agentId = resolveAgentId(bridge, command.sessionKey, command.agentId)
  const rows = bridge.autonomousRepo.capabilities(agentId)
  const dimensions: Record<string, unknown> = {}
  for (const row of rows) {
    dimensions[row.dimension] = {
      level: row.level,
      confidence: row.confidence,
      boundary: row.boundary,
      testCount: row.test_count,
      lastUpdated: row.last_updated,
    }
  }
  return { agentId, dimensions, total: rows.length }
}

export function handleAutonomousReflections(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'autonomous:reflections' }>,
): unknown {
  const agentId = resolveAgentId(bridge, command.sessionKey, command.agentId)
  const limit = command.limit ?? 5
  const rows = bridge.autonomousRepo.reflections(agentId, limit)
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.created_at,
    diagnosis: {
      primaryIssue: r.primary_issue,
      affectedDimensions: safeJsonArray(r.affected_dimensions),
      rootCause: r.root_cause,
    },
    recommendations: safeJsonArray(r.recommendations),
    suggestedGoals: safeJsonArray(r.suggested_goals),
  }))
}

export function handleAutonomousSatisfactionHistory(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'autonomous:satisfaction:history' }>,
): unknown {
  const agentId = resolveAgentId(bridge, command.sessionKey, command.agentId)
  const window = command.window ?? '7d'
  const rows = bridge.autonomousRepo.satisfactionHistory(agentId, windowStart(window))
  return {
    window,
    trend: deriveTrend(rows),
    dataPoints: rows.map((r) => ({
      timestamp: r.created_at,
      score: r.overall_score,
      breakdown: {
        taskCompletion: r.task_completion,
        userFeedback: r.user_feedback,
        efficiency: r.efficiency,
        knowledgeGrowth: r.knowledge_growth,
      },
    })),
  }
}

export function handleAutonomousPromptVariants(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'autonomous:prompt:variants' }>,
): unknown {
  const rows = bridge.autonomousRepo.promptVariants(command.fragmentKey)
  const grouped = new Map<string, unknown[]>()
  for (const row of rows) {
    const list = grouped.get(row.baseline_prompt_id) ?? []
    list.push({
      id: row.id,
      variantText: row.variant_text,
      isBaseline: row.is_baseline === 1,
      trialCount: row.trial_count,
      successCount: row.success_count,
      successRate: row.trial_count > 0 ? row.success_count / row.trial_count : null,
      avgSatisfaction: row.avg_satisfaction,
      ucbScore: row.ucb_score,
    })
    grouped.set(row.baseline_prompt_id, list)
  }
  return Array.from(grouped.entries()).map(([baselinePromptId, variants]) => ({
    baselinePromptId,
    variants,
  }))
}

export function handleAutonomousEnable(bridge: AgentRuntimeBridge): unknown {
  bridge.runtimeStateRepo.set(ENABLED_KEY, 'true')
  return { success: true, enabled: true }
}

export function handleAutonomousDisable(bridge: AgentRuntimeBridge): unknown {
  bridge.runtimeStateRepo.set(ENABLED_KEY, 'false')
  return { success: true, enabled: false }
}

/** JSON 列解析失败时退化为空数组，避免单条脏数据打断整个列表 */
function safeJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
