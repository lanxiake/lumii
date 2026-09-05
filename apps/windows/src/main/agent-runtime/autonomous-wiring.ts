/**
 * 自主进化引擎接线
 *
 * 引擎侧要 async 的 DatabaseClient（execute/query），bridge 侧只有 sync 的
 * DatabaseAdapter（prepare）。这里做适配并装配协调器，挂到回合结束事件上。
 *
 * 开关：runtime_state 键 autonomous.enabled，缺省启用。与 config.ts 里读 env 的
 * AUTONOMOUS_ENABLED 是两道闸，任一关闭即不运行。
 */

import {
  AutonomousCoordinator,
  MetaCognitionEngine,
  IntrinsicGoalGenerator,
  PromptEvolutionEngine,
  PersonalityTracker,
  SATISFACTION_WEIGHTS,
  SATISFACTION_THRESHOLD,
  EPSILON,
  MAX_VARIANTS_PER_PROMPT,
  MIN_TRIALS_BEFORE_EXPLOIT,
  UCB_CONFIDENCE,
  EMA_ALPHA,
  MAX_GOALS_PER_DAY,
  AUTONOMOUS_ENABLED,
  AUTONOMOUS_GOAL_TYPES,
  type DatabaseAdapter,
  type MVPScope,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'
import {
  readCounters,
  resetCounters,
  deriveUserFeedback,
  recordEdit,
  recordResend,
  recordAbort,
} from './autonomous-feedback-signals'

const ENABLED_KEY = 'autonomous.enabled'

/**
 * sync DatabaseAdapter → async DatabaseClient。
 * better-sqlite3 本身同步，包一层 Promise 只为满足引擎接口，无真实异步开销。
 */
function toAsyncClient(db: DatabaseAdapter) {
  return {
    async execute(sql: string, params: unknown[] = []) {
      return db.prepare(sql).run(...params)
    },
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[]
    },
  }
}

export interface AutonomousRuntime {
  coordinator: AutonomousCoordinator
  /** 回合结束时调用；内部已 try-catch，不会把异常抛给会话流程 */
  onTurnEnd(sessionId: string, agentId: string): Promise<void>
  shutdown(): Promise<void>
}

let runtime: AutonomousRuntime | null = null
let runtimeDb: DatabaseAdapter | null = null

/**
 * 由 bridge 初始化完成后调用一次。重复调用会替换旧实例（dev 热重启场景）。
 */
export function initAutonomousRuntime(db: DatabaseAdapter): void {
  try {
    runtimeDb = db
    runtime = createAutonomousRuntime(db, () => readAutonomousEnabled(db))
    log.info('[autonomous] 自主进化运行时已装配')
  } catch (err) {
    // 装配失败不能拖垮启动流程，降级为不启用
    runtime = null
    log.warn('[autonomous] 装配失败，自主进化不启用:', err instanceof Error ? err.message : err)
  }
}

/**
 * 供 IPC 层记录用户负反馈信号。
 *
 * 编辑/重发/打断都不落库（编辑是原地 UPDATE，打断无痕），
 * 必须在事件发生时主动记录，无法事后回溯。
 */
export function recordFeedbackSignal(
  conversationId: string,
  kind: 'edit' | 'resend' | 'abort',
): void {
  if (!runtimeDb) return
  try {
    if (kind === 'edit') recordEdit(runtimeDb, conversationId)
    else if (kind === 'resend') recordResend(runtimeDb, conversationId)
    else recordAbort(runtimeDb, conversationId)
  } catch (err) {
    log.warn('[autonomous] 记录反馈信号失败:', err instanceof Error ? err.message : err)
  }
}

export async function shutdownAutonomousRuntime(): Promise<void> {
  try {
    await runtime?.shutdown()
  } catch {
    /* 关闭失败无需上报 */
  }
  runtime = null
  runtimeDb = null
}

/**
 * 目标批准通知。
 *
 * 审批路径（CLI / 前端）经 AutonomousRepo 直接改状态为 approved，
 * 绕过了协调器的 goal:approved 事件，导致目标永远停在 approved、
 * 不流转到 executing、也不记 evolution-decided 人格事件。这里补一枪：
 * 从正式表重建最小目标对象，触发协调器 onGoalApproved。
 */
export function notifyAutonomousGoalApproved(goalId: string): boolean {
  if (!runtime || !runtimeDb) return false
  try {
    const row = runtimeDb
      .prepare<{ agent_id: string; type: string; description: string }>(
        `SELECT agent_id, type, description FROM autonomous_goals WHERE id = ?`,
      )
      .get(goalId)
    if (!row) return false
    runtime.coordinator.emit('goal:approved', {
      id: goalId,
      agentId: row.agent_id,
      type: row.type,
      description: row.description,
    })
    return true
  } catch (err) {
    log.warn('[autonomous] 通知目标批准失败:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * 回合结束通知。agentId 按会话归属解析，与 CLI 侧 resolveAgentId 同口径。
 */
export async function notifyAutonomousTurnEnd(conversationId: string): Promise<void> {
  if (!runtime || !runtimeDb) return
  try {
    const row = runtimeDb
      .prepare<{ agent_id: string }>(
        `SELECT agent_id FROM messages
          WHERE conversation_id = ? AND agent_id IS NOT NULL
          ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(conversationId)
    await runtime.onTurnEnd(conversationId, row?.agent_id ?? 'assistant')
  } catch (err) {
    log.warn('[autonomous] 回合结束通知失败:', err instanceof Error ? err.message : err)
  }
}

/**
 * 装配自主进化运行时。
 *
 * 不注入 ReflectionEngine：它依赖 LLMClient，会在低满意度时产生额外模型调用，
 * 需要单独的预算与灰度策略，留到反思接线时再补。
 */
export function createAutonomousRuntime(
  db: DatabaseAdapter,
  isEnabled: () => boolean,
): AutonomousRuntime {
  const asyncDb = toAsyncClient(db)

  const metaCognition = new MetaCognitionEngine(
    {
      satisfactionWeights: SATISFACTION_WEIGHTS,
      satisfactionThreshold: SATISFACTION_THRESHOLD,
      reflectionTrigger: 'scheduled',
      capabilityTracking: 'manual',
    },
    asyncDb,
  )

  const goalGenerator = new IntrinsicGoalGenerator(
    {
      enabledTypes: AUTONOMOUS_GOAL_TYPES,
      userApproval: 'always',
      maxGoalsPerDay: MAX_GOALS_PER_DAY,
      priorityWeights: { satisfactionGap: 0.6, dimensionGap: 0.4 },
    },
    asyncDb,
  )

  const promptEvolution = new PromptEvolutionEngine(
    {
      epsilon: EPSILON,
      maxVariantsPerPrompt: MAX_VARIANTS_PER_PROMPT,
      minTrialsBeforeExploit: MIN_TRIALS_BEFORE_EXPLOIT,
      ucbConfidence: UCB_CONFIDENCE,
    },
    asyncDb,
  )

  const personalityTracker = new PersonalityTracker(
    {
      emaAlpha: EMA_ALPHA,
      eventWeights: {},
      trackingEnabled: true,
      // P3 的人格主动进化未实现，保持关闭
      evolutionEnabled: false,
    },
    asyncDb,
  )

  // MVPScope 字面量类型收得很紧（如 maxGoalsPerDay: 3），这里按其声明构造
  const scope = {
    metaCognition: {
      satisfactionScoring: true,
      capabilityTracking: 'manual',
      reflectionTrigger: 'scheduled',
    },
    goalGeneration: {
      types: ['learning', 'proactive-message'],
      userApproval: 'always',
      maxGoalsPerDay: 3,
    },
    evolution: { prompt: true, memory: false, skill: false, tool: false },
    personality: { tracking: true, evolution: false, display: true },
  } as unknown as MVPScope

  const coordinator = new AutonomousCoordinator(
    metaCognition,
    goalGenerator,
    promptEvolution,
    personalityTracker,
    scope,
    asyncDb,
  )

  void coordinator.initialize()

  return {
    coordinator,

    async onTurnEnd(sessionId: string, agentId: string) {
      if (!AUTONOMOUS_ENABLED || !isEnabled()) return
      try {
        const session = buildSessionSnapshot(db, sessionId, agentId)
        if (!session) return
        // 真实负反馈信号（编辑/重发/打断）推导 user_feedback，
        // 否则该维度在单轮对话中恒为 0.5，不携带区分度
        const counters = readCounters(db, sessionId)
        await coordinator.onSessionEnd({
          ...session,
          userFeedbackOverride: deriveUserFeedback(counters),
        })
        // 评分已消费本轮信号，清零避免一次编辑永久拉低后续轮次
        resetCounters(db, sessionId)
      } catch (err) {
        // 自主进化是旁路能力，失败只记日志，绝不影响用户的会话
        log.warn('[autonomous] 回合结束处理失败:', err instanceof Error ? err.message : err)
      }
    },

    async shutdown() {
      await coordinator.shutdown()
    },
  }
}

/**
 * 从会话消息重建评分所需的快照。
 *
 * 指标口径（见 metrics-collector）：
 * - errors 用于任务完成度，取工具调用失败数
 * - messages 的 user 条数决定用户反馈维度
 */
function buildSessionSnapshot(db: DatabaseAdapter, sessionId: string, agentId: string) {
  const rows = db
    .prepare<{ role: string; timestamp: string; content_json: string }>(
      `SELECT role, timestamp, content_json FROM messages
        WHERE conversation_id = ?
        ORDER BY timestamp ASC`,
    )
    .all(sessionId)

  if (rows.length === 0) return null

  const startedAt = new Date(rows[0].timestamp)
  const endedAt = new Date(rows[rows.length - 1].timestamp)

  // 工具调用与失败数从 tool_result 消息统计：任务完成度与效率维度都依赖它，
  // 恒传空数组会让完成度永远算成 1.0
  const toolCalls: Array<{ success: boolean; toolName?: string }> = []
  const errors: Array<{ message: string }> = []
  for (const row of rows) {
    const parsed = tryParse(row.content_json)
    if (parsed?.type !== 'tool_result') continue
    const isError = parsed.is_error === true
    toolCalls.push({
      success: !isError,
      toolName: typeof parsed.tool_name === 'string' ? parsed.tool_name : undefined,
    })
    if (isError) errors.push({ message: String(parsed.tool_name ?? 'tool') })
  }

  return {
    id: sessionId,
    agentId,
    startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
    endedAt: Number.isNaN(endedAt.getTime()) ? new Date() : endedAt,
    messages: rows.map((r) => ({ role: r.role, content: '' })),
    toolCalls,
    errors,
  }
}

function tryParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 读开关：未写过配置时默认启用 */
export function readAutonomousEnabled(db: DatabaseAdapter): boolean {
  try {
    const row = db
      .prepare<{ value: string }>('SELECT value FROM runtime_state WHERE key = ?')
      .get(ENABLED_KEY)
    return row?.value !== 'false'
  } catch {
    return true
  }
}
