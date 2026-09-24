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
import type { ConfigManager } from '../config-manager'
import { notifyAutonomousGoalApproved } from '../agent-runtime/autonomous-wiring'
import { readSettings, writeSettings } from '@mtbot/agent-runtime'
import type { AutonomousSettings } from '@mtbot/agent-runtime'
import { readMood, readConcerns, EVOLUTION_CONVERSATION_ID } from '@mtbot/agent-runtime'
import { petAgentId } from '@mtbot/pet-core'
import { isPetMode } from '../pet/pet-mode-ipc'
import { getStoredModelId } from '../pet/pet-mode-store'

const ENABLED_KEY = 'autonomous.enabled'

/**
 * 面板的主体：**当前宠物**（2026-09-24 主体迁移，设计 §12.5）。
 *
 * 不在宠物模式（或还没选模型）时返回这个**哨兵** —— 它不会匹配任何一行数据，
 * 于是面板上那些按 `agent_id` 的查询自然返回空，不必在十个 handler 里各写一遍空态分支。
 *
 * **刻意不回落到助手**：助手那条线已经不再跑自主进化（实施计划第六期 T6.4），
 * 把它的历史当成"当前状态"显示只会让人以为它还在动。历史一条都没删，仍在库里。
 *
 * ⚠ 唯一需要单独处理的是 `autonomous:getMood`：`readMood` 对"没有记录"返回的是
 * **默认心情**而不是空，所以那里显式判了一次。
 */
const NO_SUBJECT_AGENT_ID = '__none__'
function subjectAgentId(): string {
  try {
    return isPetMode() ? petAgentId(getStoredModelId()) : NO_SUBJECT_AGENT_ID
  } catch {
    return NO_SUBJECT_AGENT_ID
  }
}

/** app 配置访问（由 ipc-handlers-registry 注入；未注入时相关 handler 降级为空） */
let _getConfigManager: (() => ConfigManager | null) | null = null

export function setAutonomousIpcDeps(deps: { getConfigManager: () => ConfigManager | null }): void {
  _getConfigManager = deps.getConfigManager
}

/** bridge 未就绪时抛出，由各 handler 兜底为降级返回值 */
function requireBridge(): AgentRuntimeBridge {
  const bridge = getAgentRuntimeBridge()
  if (!bridge) throw new Error('AgentRuntimeBridge 未就绪')
  return bridge
}

/** 从 content_json 提取纯文本（日记/独白统一存 { type:'text', text }） */
function extractInnerText(contentJson: unknown): string {
  try {
    const parsed = typeof contentJson === 'string' ? JSON.parse(contentJson) : contentJson
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>
      if (typeof p.text === 'string') return p.text
      if (typeof p.content === 'string') return p.content
    }
    return typeof contentJson === 'string' ? contentJson : ''
  } catch {
    return typeof contentJson === 'string' ? contentJson : ''
  }
}

/** 未写过配置时默认关闭（实验性功能，需用户在设置页主动开启） */
function readEnabled(bridge: AgentRuntimeBridge): boolean {
  return bridge.runtimeStateRepo.get(ENABLED_KEY) === 'true'
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

/** 空数据时的降级形状：保持 enabled 语义（缺省禁用），其余归零 */
function emptyStatus(enabled = false) {
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
    const agentId = subjectAgentId()
    const latest = bridge.autonomousRepo.latestSatisfaction(agentId)
    const pendingGoalsCount = bridge.autonomousRepo.countGoalsByStatus(agentId, 'pending')

    if (!latest) return { ...emptyStatus(enabled), pendingGoalsCount }

    const recent = bridge.autonomousRepo.satisfactionHistory(agentId, windowStart('7d'))
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

/** 最近目标（全状态，时间倒序，最多 limit 条），附生成时回填的关联反思 ID */
ipcMain.handle('autonomous:getGoals', async (_event, limit = 20) => {
  try {
    const bridge = requireBridge()
    const goals = bridge.autonomousRepo.listGoals(subjectAgentId()).slice(0, limit)
    return goals.map((g) => ({
      id: g.id,
      type: g.type,
      description: g.description,
      triggerReason: g.trigger_reason,
      status: g.status,
      priority: g.priority,
      createdAt: g.created_at,
      approvedAt: g.approved_at,
      reflectionId: g.reflection_id,
    }))
  } catch (error) {
    console.error('[autonomous:getGoals]', error)
    return []
  }
})

/** 规划器产出的目标（planned_by='planner'，时间倒序），含计划执行时间 scheduledFor */
ipcMain.handle('autonomous:getPlannedGoals', async (_event, limit = 50) => {
  try {
    const bridge = requireBridge()
    const goals = bridge.autonomousRepo
      .listGoals(subjectAgentId())
      .filter((g) => g.planned_by === 'planner')
      .slice(0, limit)
    return goals.map((g) => ({
      id: g.id,
      type: g.type,
      description: g.description,
      triggerReason: g.trigger_reason,
      status: g.status,
      priority: g.priority,
      createdAt: g.created_at,
      approvedAt: g.approved_at,
      reflectionId: g.reflection_id,
      scheduledFor: g.scheduled_for,
      plannedBy: g.planned_by,
    }))
  } catch (error) {
    console.error('[autonomous:getPlannedGoals]', error)
    return []
  }
})

/** 删除规划目标（硬删，供「规划任务」tab 移除被规划的任务） */
ipcMain.handle('autonomous:deleteGoal', async (_event, goalId: string) => {
  const bridge = requireBridge()
  const ok = bridge.autonomousRepo.deleteGoal(goalId)
  if (!ok) throw new Error('目标不存在')
  return { success: true, goalId }
})

/** 手动触发某个主体重新规划（供「规划任务」tab 重置按钮） */
ipcMain.handle('autonomous:replan', async () => {
  const bridge = requireBridge()
  const agentId = subjectAgentId()
  if (agentId === NO_SUBJECT_AGENT_ID) return { success: false }
  const ok = await bridge.triggerReplan(agentId)
  return { success: ok }
})

ipcMain.handle('autonomous:approveGoal', async (_event, goalId: string, note?: string) => {
  const bridge = requireBridge()
  const ok = bridge.autonomousRepo.approveGoal(goalId, note)
  if (!ok) throw new Error('目标不存在或不处于 pending 状态')
  notifyAutonomousGoalApproved(goalId)
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
    for (const row of bridge.autonomousRepo.capabilities(subjectAgentId())) {
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

ipcMain.handle('autonomous:getCapabilityTests', async (_event, dimension?: string, limit = 100) => {
  try {
    const bridge = requireBridge()
    return bridge.autonomousRepo.capabilityTests(subjectAgentId(), dimension, limit).map((t) => ({
      id: t.id,
      dimension: t.dimension,
      taskSummary: t.task_summary,
      difficulty: t.difficulty,
      result: t.result,
      levelBefore: t.level_before,
      levelAfter: t.level_after,
      createdAt: t.created_at,
    }))
  } catch (error) {
    console.error('[autonomous:getCapabilityTests]', error)
    return []
  }
})

ipcMain.handle('autonomous:getReflections', async (_event, limit = 10) => {
  try {
    const bridge = requireBridge()
    return bridge.autonomousRepo.reflections(subjectAgentId(), limit).map((r) => ({
      id: r.id,
      triggerReason: r.trigger_reason,
      createdAt: r.created_at,
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
    const rows = bridge.autonomousRepo.satisfactionHistory(subjectAgentId(), windowStart(window))
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
  // 即时生效：重播 evolution tick cron（enabled 跟随开关）+ 重载本地 cron 调度
  bridge.syncEvolutionTickSettings?.()
  return { success: true, enabled }
})

ipcMain.handle('autonomous:settings:get', async () => {
  const bridge = requireBridge()
  return readSettings(bridge.db)
})

ipcMain.handle('autonomous:settings:update', async (_event, settings: Partial<AutonomousSettings>) => {
  const bridge = requireBridge()
  writeSettings(bridge.db, settings)
  // 心跳周期变更即时生效（与 CLI autonomous settings set 同一路径）
  bridge.syncEvolutionTickSettings?.()
  return readSettings(bridge.db)
})

ipcMain.handle('autonomous:getMood', async () => {
  const bridge = requireBridge()
  const agentId = subjectAgentId()
  // `readMood` 对"没有记录"返回的是**默认心情**而不是空 —— 不在宠物模式时要说的是
  // "没有"，不是"它心情 0.6"。这是全部 handler 里唯一需要显式判哨兵的地方。
  if (agentId === NO_SUBJECT_AGENT_ID) return null
  return readMood(bridge.db, agentId)
})

ipcMain.handle('autonomous:getConcerns', async () => {
  const bridge = requireBridge()
  return readConcerns(bridge.db, subjectAgentId())
})

ipcMain.handle(
  'autonomous:getDiary',
  async (_event, limit = 20, before?: { timestamp: number; id: string }) => {
    const bridge = requireBridge()
    const agentId = subjectAgentId()
    if (agentId === NO_SUBJECT_AGENT_ID) return { items: [], hasMore: false, nextBefore: null }
    // 日记在**它自己的**会话里：助手 `evolution:main`、宠物 `evolution:pet:<模型ID>`。
    // 会话 id 由 bridge 给出，不在这里拼前缀（那条"谁是 assistant"的规则只有一个定义处）
    const page = bridge.conversationRepo.loadMessagesPage(
      bridge.evolutionConversationIdFor(agentId),
      {
        limit,
        before: before
          ? { timestamp: new Date(before.timestamp).toISOString(), id: before.id }
          : undefined,
      },
    )
    const items = page.items
      .filter((m) => m.role === 'assistant')
      .map((m) => ({
        id: m.id,
        text: extractInnerText(m.content_json),
        timestamp: new Date(m.timestamp).getTime(),
      }))
      .filter((e) => e.text.trim().length > 0)
      .reverse()
    // 下一页游标：当前页最早一条原始消息（升序首条），严格早于它的才是更早历史
    const oldest = page.items[0]
    const nextBefore =
      page.hasMore && oldest
        ? { timestamp: new Date(oldest.timestamp).getTime(), id: oldest.id }
        : null
    return { items, hasMore: page.hasMore, nextBefore }
  },
)

/** 读取开启自主能力的额外 Agent id 列表（除 assistant 外；assistant 恒参与不列入） */
ipcMain.handle('autonomous:getAgents', async () => {
  return _getConfigManager?.()?.getAppConfig().autonomousAgents ?? []
})

/** 设置开启自主能力的额外 Agent id 列表（去重、去空、排除 assistant） */
ipcMain.handle('autonomous:setAgents', async (_event, agentIds: unknown) => {
  const raw = Array.isArray(agentIds) ? agentIds : []
  const sanitized = [
    ...new Set(
      raw
        .map((v) => String(v ?? '').trim())
        .filter((v) => v && v !== 'assistant'),
    ),
  ]
  await _getConfigManager?.()?.updateAppConfig({
    autonomousAgents: sanitized.length > 0 ? sanitized : undefined,
  })
  return { ok: true }
})

export function registerAutonomousIpcHandlers() {
  // handler 已在模块加载时通过 ipcMain.handle 注册
}
