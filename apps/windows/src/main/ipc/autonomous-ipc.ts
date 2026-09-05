/**
 * 自主进化 IPC 处理器
 *
 * 与 CLI 命令共用 bridge.autonomousRepo，读写 agent-runtime.db 中
 * V28-V31 迁移建立的正式表。不自建库、不落演示数据——表为空即真实状态。
 *
 * 开关状态存 runtime_state 的 autonomous.enabled，与 CLI 的
 * autonomous enable/disable 及引擎的启用判断是同一个键。
 */
import { ipcMain } from 'electron'
import { getAgentRuntimeBridge } from './agent-runtime-ipc'
import type { AgentRuntimeBridge } from '../agent-runtime/bridge'

const ENABLED_KEY = 'autonomous.enabled'
const DEFAULT_AGENT_ID = 'assistant'

/** bridge 未就绪时抛出，由各 handler 兜底为降级返回值 */
function requireBridge(): AgentRuntimeBridge {
  const bridge = getAgentRuntimeBridge()
  if (!bridge) throw new Error('AgentRuntimeBridge 未就绪')
  return bridge
}

/** 未写过配置时默认启用 */
function readEnabled(bridge: AgentRuntimeBridge): boolean {
  return bridge.runtimeStateRepo.get(ENABLED_KEY) !== 'false'
}

/** 由首尾两点判定趋势；样本不足按 stable 处理 */
function deriveTrend(history: { overall_score: number }[]): 'improving' | 'stable' | 'declining' {
  if (history.length < 2) return 'stable'
  const delta = history[history.length - 1].overall_score - history[0].overall_score
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

function safeJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 空数据时的降级形状：保持 enabled 语义，其余归零 */
function emptyStatus(enabled = true) {
  return {
    enabled,
    satisfaction: {
      overall: 0,
      trend: 'stable' as const,
      breakdown: { taskCompletion: 0, userFeedback: 0, efficiency: 0, knowledgeGrowth: 0 },
      lastUpdated: new Date().toISOString(),
    },
    pendingGoalsCount: 0,
    hasData: false,
  }
}

ipcMain.handle('autonomous:getStatus', async () => {
  try {
    const bridge = requireBridge()
    const enabled = readEnabled(bridge)
    const latest = bridge.autonomousRepo.latestSatisfaction(DEFAULT_AGENT_ID)
    const pendingGoalsCount = bridge.autonomousRepo.countGoalsByStatus(DEFAULT_AGENT_ID, 'pending')

    if (!latest) return { ...emptyStatus(enabled), pendingGoalsCount }

    const recent = bridge.autonomousRepo.satisfactionHistory(DEFAULT_AGENT_ID, windowStart('7d'))
    return {
      enabled,
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
  } catch (error) {
    console.error('[autonomous:getStatus]', error)
    return emptyStatus()
  }
})

ipcMain.handle('autonomous:getPendingGoals', async () => {
  try {
    const bridge = requireBridge()
    return bridge.autonomousRepo.listGoals(DEFAULT_AGENT_ID, 'pending').map((g) => ({
      id: g.id,
      type: g.type,
      description: g.description,
      triggerReason: g.trigger_reason,
      status: g.status,
      priority: g.priority,
      createdAt: g.created_at,
      approvedAt: g.approved_at,
    }))
  } catch (error) {
    console.error('[autonomous:getPendingGoals]', error)
    return []
  }
})

ipcMain.handle('autonomous:approveGoal', async (_event, goalId: string, note?: string) => {
  const bridge = requireBridge()
  const ok = bridge.autonomousRepo.approveGoal(goalId, note)
  if (!ok) throw new Error('目标不存在或不处于 pending 状态')
  return { success: true, goalId }
})

ipcMain.handle('autonomous:rejectGoal', async (_event, goalId: string, options?: { reason?: string }) => {
  const bridge = requireBridge()
  const ok = bridge.autonomousRepo.rejectGoal(goalId, options?.reason)
  if (!ok) throw new Error('目标不存在或不处于 pending 状态')
  return { success: true, goalId }
})

ipcMain.handle('autonomous:getCapabilities', async () => {
  try {
    const bridge = requireBridge()
    const result: Record<string, unknown> = {}
    for (const row of bridge.autonomousRepo.capabilities(DEFAULT_AGENT_ID)) {
      result[row.dimension] = {
        level: row.level,
        confidence: row.confidence,
        boundary: row.boundary,
        testCount: row.test_count,
      }
    }
    return result
  } catch (error) {
    console.error('[autonomous:getCapabilities]', error)
    return {}
  }
})

ipcMain.handle('autonomous:getReflections', async (_event, limit = 10) => {
  try {
    const bridge = requireBridge()
    return bridge.autonomousRepo.reflections(DEFAULT_AGENT_ID, limit).map((r) => ({
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
  } catch (error) {
    console.error('[autonomous:getReflections]', error)
    return []
  }
})

ipcMain.handle('autonomous:getSatisfactionHistory', async (_event, window = '7d') => {
  try {
    const bridge = requireBridge()
    const rows = bridge.autonomousRepo.satisfactionHistory(DEFAULT_AGENT_ID, windowStart(window))
    return {
      dataPoints: rows.map((r) => ({
        timestamp: r.created_at,
        score: r.overall_score,
        windowType: 'short',
      })),
    }
  } catch (error) {
    console.error('[autonomous:getSatisfactionHistory]', error)
    return { dataPoints: [] }
  }
})

ipcMain.handle('autonomous:getPromptStats', async () => {
  try {
    const bridge = requireBridge()
    const grouped = new Map<string, unknown[]>()
    for (const row of bridge.autonomousRepo.promptVariants()) {
      const list = grouped.get(row.baseline_prompt_id) ?? []
      list.push({
        id: row.id,
        variantText: row.variant_text,
        isBaseline: row.is_baseline === 1,
        trialCount: row.trial_count,
        successCount: row.success_count,
        avgSatisfaction: row.avg_satisfaction,
        ucbScore: row.ucb_score,
      })
      grouped.set(row.baseline_prompt_id, list)
    }
    return Array.from(grouped.entries()).map(([fragmentKey, variants]) => ({ fragmentKey, variants }))
  } catch (error) {
    console.error('[autonomous:getPromptStats]', error)
    return []
  }
})

ipcMain.handle('autonomous:setEnabled', async (_event, enabled: boolean) => {
  const bridge = requireBridge()
  bridge.runtimeStateRepo.set(ENABLED_KEY, enabled ? 'true' : 'false')
  return { success: true, enabled }
})

ipcMain.handle('autonomous:getApprovalSettings', async () => null)

ipcMain.handle('autonomous:updateApprovalSettings', async () => {})

export function registerAutonomousIpcHandlers() {
  // handler 已在模块加载时通过 ipcMain.handle 注册
}
