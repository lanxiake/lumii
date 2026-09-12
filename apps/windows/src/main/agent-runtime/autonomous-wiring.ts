/**
 * 自主进化引擎接线
 *
 * 引擎侧要 async 的 DatabaseClient（execute/query），bridge 侧只有 sync 的
 * DatabaseAdapter（prepare）。这里做适配并装配协调器，挂到回合结束事件上。
 *
 * 开关：runtime_state 键 autonomous.enabled，缺省关闭（实验性功能，需用户在设置页
 * 主动开启）。与 config.ts 里读 env 的 AUTONOMOUS_ENABLED 是两道闸，任一关闭即不运行。
 */

import {
  AutonomousCoordinator,
  MetaCognitionEngine,
  IntrinsicGoalGenerator,
  PromptEvolutionEngine,
  PersonalityTracker,
  CapabilityTracker,
  ReflectionEngine,
  createExtendedDbClient,
  SATISFACTION_WEIGHTS,
  SATISFACTION_THRESHOLD,
  EPSILON,
  MAX_VARIANTS_PER_PROMPT,
  MIN_TRIALS_BEFORE_EXPLOIT,
  UCB_CONFIDENCE,
  EMA_ALPHA,
  AUTONOMOUS_ENABLED,
  AUTONOMOUS_GOAL_TYPES,
  EVOLUTION_CONVERSATION_ID,
  readMood,
  computeExplorationRate,
  readConcerns,
  writeConcerns,
  readSettings,
  type DatabaseAdapter,
  type ReflectionOutput,
  type Concern,
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
const PROMPT_VARIANT_KEY_PREFIX = 'prompt-variant:'
/** Prompt 进化的片段键：先在「表达风格」这一无害维度上做 A/B，不碰身份/工具/安全 */
const BASELINE_PROMPT_ID = 'expression-style'

function variantKey(conversationId: string): string {
  return `${PROMPT_VARIANT_KEY_PREFIX}${conversationId}`
}

function writeVariantId(db: DatabaseAdapter, conversationId: string, variantId: string): void {
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(variantKey(conversationId), variantId, new Date().toISOString())
}

function readVariantId(db: DatabaseAdapter, conversationId: string): string | undefined {
  try {
    const row = db
      .prepare<{ value: string }>('SELECT value FROM runtime_state WHERE key = ?')
      .get(variantKey(conversationId))
    return row?.value || undefined
  } catch {
    return undefined
  }
}

/** 读人格开放性（personality_state 表）；未初始化时返回中性 0.5。 */
function readOpenness(db: DatabaseAdapter, agentId: string): number {
  try {
    const row = db
      .prepare<{ openness: number }>('SELECT openness FROM personality_state WHERE agent_id = ?')
      .get(agentId)
    return typeof row?.openness === 'number' ? row.openness : 0.5
  } catch {
    return 0.5
  }
}

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
  /** 触发一次自我反思（需装配了 LLM 客户端）；缺 LLM 时抛错 */
  reflect(agentId: string, triggerReason: 'scheduled' | 'low-satisfaction' | 'user-request'): Promise<ReflectionOutput>
  /** 为本会话选一个 Prompt 变体并记录其 id（回合结束回写奖励） */
  selectPromptVariant(conversationId: string): Promise<{ variantId: string; variantText: string }>
  shutdown(): Promise<void>
}

let runtime: AutonomousRuntime | null = null
let runtimeDb: DatabaseAdapter | null = null

/** 系统通知能力（桥接注入；未注入时静默）——签名与 showCronNotification 一致 */
let goalNotifier: ((title: string, body: string, convId?: string) => void) | null = null
/** 上次已知的 pending 目标数（增量提醒基线；null 表示尚未初始化） */
let lastPendingGoalCount: number | null = null

/** 由桥接在装配自主进化运行时时注入系统通知能力（一次即可） */
export function setAutonomousNotifier(
  fn: (title: string, body: string, convId?: string) => void,
): void {
  goalNotifier = fn
}

/**
 * 待审批目标增量提醒：pending 数较上次增加时发一条系统通知。
 *
 * 三条目标生成路径（回合结束低满意 / 反思建议 / planner）落库后调用；
 * 只提醒增量（批准/拒绝后数量回落不触发），首次调用仅建立基线。
 */
export function notifyNewPendingGoals(): void {
  if (!runtimeDb) return
  try {
    const row = runtimeDb
      .prepare<{ count: number }>(
        `SELECT COUNT(*) as count FROM autonomous_goals WHERE agent_id = 'assistant' AND status = 'pending'`,
      )
      .get()
    const count = row?.count ?? 0
    if (lastPendingGoalCount === null) {
      lastPendingGoalCount = count
      return
    }
    if (count > lastPendingGoalCount) {
      const added = count - lastPendingGoalCount
      goalNotifier?.(
        'Lumii',
        `有 ${added} 个新目标待你审批（共 ${count} 个），点击查看`,
        EVOLUTION_CONVERSATION_ID,
      )
    }
    lastPendingGoalCount = count
  } catch (err) {
    log.warn('[autonomous] 待审批目标提醒失败:', err instanceof Error ? err.message : err)
  }
}

/**
 * 由 bridge 初始化完成后调用一次。重复调用会替换旧实例（dev 热重启场景）。
 * callLLM 复用桥接的独立 LLM 管道（同记忆提取/整理），用于反思引擎。
 */
export function initAutonomousRuntime(
  db: DatabaseAdapter,
  callLLM?: (prompt: string) => Promise<string>,
): void {
  try {
    runtimeDb = db
    runtime = createAutonomousRuntime(db, () => readAutonomousEnabled(db), callLLM)
    log.info('[autonomous] 自主进化运行时已装配' + (callLLM ? '（含反思引擎）' : ''))
  } catch (err) {
    // 装配失败不能拖垮启动流程，降级为不启用
    runtime = null
    log.warn('[autonomous] 装配失败，自主进化不启用:', err instanceof Error ? err.message : err)
  }
}

/**
 * 供外部（CLI / 定时任务）触发一次自我反思。
 * 反思会真实调用一次 LLM，耗时较长，需调用方决定是否 await。
 */
export async function reflectAutonomous(
  agentId: string,
  triggerReason: 'scheduled' | 'low-satisfaction' | 'user-request',
): Promise<ReflectionOutput> {
  if (!runtime) throw new Error('自主进化运行时未装配')
  const result = await runtime.reflect(agentId, triggerReason)
  // 反思建议目标已在 reflect 内部落库（landSuggestedGoals）；此处做待审批增量提醒
  notifyNewPendingGoals()
  return result
}

/**
 * 供 bridge 在装配实例时选一个 Prompt 变体并注入。
 * 返回 null 表示未启用或选择失败（调用方按「不注入」处理，绝不影响启动）。
 */
export async function selectPromptVariantForSession(
  conversationId: string,
): Promise<{ variantId: string; variantText: string } | null> {
  if (!runtime || !conversationId) return null
  try {
    return await runtime.selectPromptVariant(conversationId)
  } catch (err) {
    log.warn('[autonomous] 选择 Prompt 变体失败:', err instanceof Error ? err.message : err)
    return null
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
    // 低满意目标可能已在上面的管道中生成；做待审批增量提醒
    notifyNewPendingGoals()
  } catch (err) {
    log.warn('[autonomous] 回合结束通知失败:', err instanceof Error ? err.message : err)
  }
}

/**
 * 装配自主进化运行时。
 *
 * callLLM 复用桥接的独立 LLM 管道（同记忆提取/整理）装配反思引擎；
 * 缺省不装配反思，避免无 LLM 时启动报错。
 */
export function createAutonomousRuntime(
  db: DatabaseAdapter,
  isEnabled: () => boolean,
  callLLM?: (prompt: string) => Promise<string>,
): AutonomousRuntime {
  const asyncDb = toAsyncClient(db)
  const extendedDb = createExtendedDbClient(asyncDb)

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
      // 动态读取设置，设置页修改 maxGoalsPerDay / approvalMode 即时生效
      maxGoalsPerDay: () => readSettings(db).maxGoalsPerDay,
      approvalMode: () => readSettings(db).approvalMode,
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

  // 播种表达风格变体（幂等，仅首次）；A/B 需要至少一个变体才有对比
  void seedPromptVariants(promptEvolution)

  const personalityTracker = new PersonalityTracker(
    {
      emaAlpha: EMA_ALPHA,
      eventWeights: {},
      trackingEnabled: true,
    },
    asyncDb,
  )

  const capabilityTracker = new CapabilityTracker(extendedDb)

  let reflectionEngine: ReflectionEngine | undefined
  if (callLLM) {
    // 反思引擎要 LLMClient.complete()；桥接的 callLLM 返回纯文本，
    // 这里包成 { content } 结构。model/temperature/maxTokens 由桥接模型配置接管。
    const llmClient = {
      complete: async ({ prompt }: { prompt: string }): Promise<{ content: string }> => {
        const content = await callLLM(prompt)
        return { content }
      },
    }
    reflectionEngine = new ReflectionEngine(extendedDb, llmClient, metaCognition, capabilityTracker)
  }

  const coordinator = new AutonomousCoordinator(
    metaCognition,
    goalGenerator,
    promptEvolution,
    personalityTracker,
    asyncDb,
    capabilityTracker,
    reflectionEngine,
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

    async reflect(agentId: string, triggerReason: 'scheduled' | 'low-satisfaction' | 'user-request') {
      if (!reflectionEngine) {
        throw new Error('反思引擎未装配（缺少 LLM 客户端），无法触发反思')
      }
      const output = await reflectionEngine.reflect(agentId, triggerReason)
      // 反思顺带识别牵挂（零额外 LLM 调用），合并写入 runtime_state
      mergeSuggestedConcerns(db, output.suggestedConcerns)
      // 反思建议目标 → 达到阈值的落成真实目标（供概览最近目标展示，可删）
      landSuggestedGoals(db, output, agentId)
      return output
    },

    async selectPromptVariant(conversationId: string) {
      const variant = await promptEvolution.selectPrompt(
        BASELINE_PROMPT_ID,
        computeExplorationRate(readMood(db), readOpenness(db, 'assistant')),
      )
      writeVariantId(db, conversationId, variant.id)
      return { variantId: variant.id, variantText: variant.variantText }
    },

    async shutdown() {
      await coordinator.shutdown()
    },
  }
}

/**
 * 播种 Prompt 进化变体（幂等）。首次运行时基线为空，创建基线 + 两个表达风格变体，
 * 之后 selectPrompt 的 ε-greedy 才有的选。失败只记日志，不影响任何会话。
 */
async function seedPromptVariants(promptEvolution: PromptEvolutionEngine): Promise<void> {
  try {
    const existing = await promptEvolution.getVariantPerformance(BASELINE_PROMPT_ID)
    if (existing.length > 0) return
    await promptEvolution.selectPrompt(BASELINE_PROMPT_ID) // 创建基线（variantText 为空 = 默认行为）
    await promptEvolution.createVariant(BASELINE_PROMPT_ID, '回答尽量简洁，直达要点，少铺垫。')
    await promptEvolution.createVariant(BASELINE_PROMPT_ID, '回答尽量详尽，多给背景与理由。')
    log.info('[autonomous] 已播种表达风格 Prompt 变体')
  } catch (err) {
    log.warn('[autonomous] 播种 Prompt 变体失败:', err instanceof Error ? err.message : err)
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

  // 工具调用与失败数：兼容两种消息形态
  // - tool_result 消息（旧形态）：tool_name / is_error
  // - assistant_parts 消息（当前形态）：parts 里的 tool part（name / isError / status）
  const toolCalls: Array<{ success: boolean; toolName?: string }> = []
  const errors: Array<{ message: string }> = []
  for (const row of rows) {
    const parsed = tryParse(row.content_json)
    if (!parsed) continue
    if (parsed.type === 'tool_result') {
      const isError = parsed.is_error === true
      toolCalls.push({
        success: !isError,
        toolName: typeof parsed.tool_name === 'string' ? parsed.tool_name : undefined,
      })
      if (isError) errors.push({ message: String(parsed.tool_name ?? 'tool') })
    } else if (parsed.type === 'assistant_parts' && Array.isArray(parsed.parts)) {
      for (const part of parsed.parts as Array<Record<string, unknown>>) {
        if (part?.type !== 'tool') continue
        const isError = part.isError === true || part.status === 'error'
        toolCalls.push({
          success: !isError,
          toolName: typeof part.name === 'string' ? part.name : undefined,
        })
        if (isError) errors.push({ message: String(part.name ?? 'tool') })
      }
    }
  }

  return {
    id: sessionId,
    agentId,
    startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
    endedAt: Number.isNaN(endedAt.getTime()) ? new Date() : endedAt,
    messages: rows.map((r) => ({ role: r.role, content: '' })),
    toolCalls,
    errors,
    variantId: readVariantId(db, sessionId),
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

/** 读开关：未写过配置时默认关闭（实验性功能，需用户在设置页主动开启） */
export function readAutonomousEnabled(db: DatabaseAdapter): boolean {
  try {
    const row = db
      .prepare<{ value: string }>('SELECT value FROM runtime_state WHERE key = ?')
      .get(ENABLED_KEY)
    return row?.value === 'true'
  } catch {
    return false
  }
}

/**
 * 把反思顺带识别出的牵挂合并进 runtime_state（autonomous.concerns）。
 * 补全 Concern 缺失字段（id/arousalWeight/raisedCount/nextRaiseAfter/status），
 * 按 description 去重，避免日频反思反复累积同一件牵挂。
 */
function mergeSuggestedConcerns(db: DatabaseAdapter,
  suggested: Array<{ description: string; origin: string }>,
): void {
  if (!suggested || suggested.length === 0) return
  try {
    const existing = readConcerns(db)
    const mood = readMood(db)
    const now = Date.now()
    const seen = new Set(existing.map((c) => c.description))
    const fresh: Concern[] = suggested
      .filter((c) => c.description && !seen.has(c.description))
      .map((c, i) => ({
        id: `${now}-${i}`,
        description: c.description,
        origin: c.origin,
        arousalWeight: mood.arousal,
        raisedCount: 0,
        nextRaiseAfter: now + 24 * 3_600_000,
        status: 'open',
      }))
    if (fresh.length > 0) writeConcerns(db, [...existing, ...fresh])
  } catch (err) {
    log.warn('[autonomous] 写入牵挂失败:', err instanceof Error ? err.message : err)
  }
}

/**
 * 把反思产出的建议目标，按优先级阈值落成真实目标（autonomous_goals）。
 *
 * - 达到 reflectionGoalPriorityThreshold 的 suggestedGoals 才创建；
 *   否则留在 reflections.suggested_goals 里即可（对应设置页「反思建议进入最近目标」阈值）。
 * - planned_by='trigger'、reflection_id=本次反思、trigger_reason='reflection-suggestion'，
 *   与规划器（planner）产出的目标区分，前端「规划任务」tab 只取 planner 目标。
 * - 状态跟随审批模式（active 类型靠既有的 approveGoal/rejectGoal 走审批）。
 */
function landSuggestedGoals(
  db: DatabaseAdapter,
  output: ReflectionOutput,
  agentId: string,
): void {
  const goals = output.suggestedGoals
  if (!goals || goals.length === 0) return
  const threshold = readSettings(db).reflectionGoalPriorityThreshold
  const accepted = goals.filter((g) => g && typeof g.description === 'string' && g.description.trim().length > 0 && g.priority >= threshold)
  if (accepted.length === 0) return
  try {
    // 去重：跳过已有同类型+同描述的未完成目标（pending/approved/executing），避免反复反思反复落库
    const existing = db
      .prepare<{ type: string; description: string }>(
        `SELECT type, description FROM autonomous_goals
          WHERE agent_id = ? AND status IN ('pending','approved','executing')`,
      )
      .all(agentId);
    const seen = new Set(existing.map((r) => `${r.type}::${r.description}`));

    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO autonomous_goals
       (id, agent_id, type, description, trigger_reason, status, priority, metadata,
        reflection_id, scheduled_for, planned_by, created_at)
       VALUES (?, ?, ?, ?, 'reflection-suggestion', 'pending', ?, ?, ?, NULL, 'trigger', ?)`,
    )
    let landed = 0
    for (const g of accepted) {
      const desc = g.description.trim()
      if (seen.has(`${g.type}::${desc}`)) continue
      const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      insert.run(
        id,
        agentId,
        g.type,
        desc,
        g.priority,
        JSON.stringify({ source: 'reflection-suggestion' }),
        output.id,
        now,
      )
      landed++
    }
    if (landed > 0) {
      log.info(`[autonomous] 反思建议目标落库 landed=${landed} threshold=${threshold}`)
    }
  } catch (err) {
    log.warn('[autonomous] 反思建议目标落库失败:', err instanceof Error ? err.message : err)
  }
}
