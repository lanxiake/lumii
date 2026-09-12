/**
 * 自主进化心跳 tick 主逻辑（Windows 客户端专用）
 *
 * 对应设计文档 10 §4：每个 tick 走「感知 → 决策 → 执行」。
 * - 感知与决策是纯逻辑，放 agent-runtime 包（tick-signals.ts）
 * - 执行动作（落独白 / 跑目标 / 发消息 / 反思）在本文件，由 bridge 注入副作用
 *
 * 多 Agent（2026-09-13）：tick 遍历 listAutonomousAgentIds() 返回的每个 Agent，
 * 逐个走「感知 → 决策 → 执行」；单 Agent（默认路径）保持旧返回格式不变。
 *
 * 本文件同时负责播种 evolution tick 的 cron job（'every' + 10 分钟间隔）。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import {
  collectTickSignals,
  decideAction,
  readSettings,
  TOKEN_COST,
  recordTokenUsage,
  type ApprovedGoalSignal,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

const EVOLUTION_TICK_CRON_ID = 'autonomous-tick'
const EVOLUTION_TICK_NAME = '自主进化心跳'
const EVOLUTION_TICK_INSTRUCTION = '__evolution_tick__'
/** 缺省参与的自主 Agent（保持单 Agent 行为不变） */
const DEFAULT_AUTONOMOUS_AGENT_IDS = ['assistant'] as const

/** evolution tick 依赖的副作用注入（由 bridge 在装配时提供） */
export interface EvolutionTickDeps {
  getDb: () => DatabaseAdapter
  isAutonomousEnabled: () => boolean
  hasActiveUserTurn: () => boolean
  /**
   * 参与本次 tick 遍历的自主 Agent 列表（含 assistant）。
   * 缺省 ['assistant']；长度 1 时保持旧的返回格式。
   */
  listAutonomousAgentIds?: () => string[]
  /** 往该 Agent 的自主会话追加一条内心独白（内部负责 ensureConversationExists） */
  appendEvolutionMessage: (agentId: string, text: string) => void
  /** 执行一个已批准目标（复用 bridge 的驱动能力 + 工具白名单护栏） */
  executeGoal: (goal: ApprovedGoalSignal, agentId: string, selfCheckBias?: boolean) => Promise<string>
  /** 发送一条主动消息（proactive-message 目标，走系统通知 + 预算计数） */
  sendOutreach: (goal: ApprovedGoalSignal, agentId: string) => Promise<string>
  /** 触发一次自我反思（复用已装配的 ReflectionEngine） */
  reflect: (agentId: string) => Promise<string>
  /** 写一篇今日日记（LLM 生成 + 落该 Agent 的自主会话） */
  writeDiary: (agentId: string) => Promise<string>
  /** 兜底拉起一次主动规划；返回 null 表示本次不规划（静默时段外或未超期） */
  plan?: (agentId: string) => Promise<string | null>
  /** 当前时间（可注入，默认 new Date()；测试用于固定静默时段） */
  now?: () => Date
  /** 驱动待处理的云同步冲突目标（系统维护，独立于自主进化开关与能量/预算门闩）。
   *  由 bridge 注入，在心跳 tick 中检测到 type='system-maintenance' 的 executing 目标时调用。
   *  返回 null 表示无冲突待处理；非 null 为执行结果摘要。 */
  driveConflictGoal?: () => Promise<string | null>
}

/**
 * 执行一次心跳 tick。
 *
 * 单 Agent（默认）：返回该 Agent 的结果字符串（与多 Agent 改造前完全一致）。
 * 多 Agent：逐个执行并汇总为 `agentId=结果; agentId=结果`；单个 Agent 失败不影响其余。
 *
 * 全程 try-catch，任何异常只记日志并返回 error 字符串，绝不抛给 cron 调度层。
 * 返回值写入 local_cron_runs.summary，供定时任务页查看。
 */
export async function handleEvolutionTick(deps: EvolutionTickDeps): Promise<string> {
  try {
    // ── 云同步冲突目标优先处理 ──
    // 系统维护任务（assistant 专属），独立于自主进化开关 / 能量 / token 预算 / 用户对话阻塞。
    // 由 bridge 注入的 driveConflictGoal 负责找到 executing 的 system-maintenance 目标
    // 并用受限实例 + 冲突工具驱动 Agent 解决。
    if (deps.driveConflictGoal) {
      try {
        const maintenance = await deps.driveConflictGoal()
        if (maintenance) return maintenance
      } catch (err) {
        log.warn('[handleEvolutionTick] 冲突驱动失败:', err instanceof Error ? err.message : String(err))
      }
    }

    if (!deps.isAutonomousEnabled()) return 'skipped: disabled'
    if (deps.hasActiveUserTurn()) return 'skipped: user turn in progress'

    const now = deps.now?.() ?? new Date()
    const requested = deps.listAutonomousAgentIds?.() ?? []
    const agentIds = requested.length > 0 ? requested : [...DEFAULT_AUTONOMOUS_AGENT_IDS]

    // 单 Agent（默认路径）保持旧的返回格式（既有 E2E 与 cron runs summary 断言依赖）
    if (agentIds.length === 1) {
      return runTickForAgent(deps, agentIds[0], now)
    }

    const results: string[] = []
    for (const agentId of agentIds) {
      try {
        results.push(`${agentId}=${await runTickForAgent(deps, agentId, now)}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error(`[handleEvolutionTick] agent=${agentId} 失败:`, err)
        results.push(`${agentId}=error: ${message}`)
      }
    }
    return results.join('; ')
  } catch (err) {
    log.error('[handleEvolutionTick] 失败:', err)
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** 单个 Agent 的「感知 → 决策 → 执行」 */
async function runTickForAgent(deps: EvolutionTickDeps, agentId: string, now: Date): Promise<string> {
  const signals = collectTickSignals(deps.getDb(), agentId, now)

  // 健康检查（保活看门狗）：卡死的 executing 目标只记日志告警，不阻断、不自动改状态。
  // 心跳的职责从「凭空决定该做什么」降为「确认还活着 + 派发已计划的事 + 兜底」。
  if (signals.stuckGoalCount > 0) {
    log.warn(
      `[handleEvolutionTick] agent=${agentId} 健康检查：${signals.stuckGoalCount} 个 executing 目标疑似卡死（超过阈值仍未完成）`,
    )
  }

  const action = decideAction(signals, now)

  if (action.kind === 'idle') {
    log.info(`[handleEvolutionTick] agent=${agentId} idle reason=${action.reason}`)
    // 兜底：健康且无任何已计划/到期的事时，规划器若已超期则补一次规划（静默时段内）
    if (action.reason === 'no-action-needed' && deps.plan) {
      const planSummary = await deps.plan(agentId)
      if (planSummary) {
        log.info(`[handleEvolutionTick] agent=${agentId} plan result=${planSummary}`)
        return `plan: ${planSummary}`
      }
    }
    // 健康且无任何已计划的事 → 保活成功；其余 idle（低能量/预算耗尽）保持原语义
    return action.reason === 'no-action-needed' ? 'idle: liveness-ok' : 'idle'
  }
  if (action.kind === 'outreach' && action.goal) {
    const result = await deps.sendOutreach(action.goal, agentId)
    log.info(`[handleEvolutionTick] agent=${agentId} outreach goalId=${action.goal.id} result=${result}`)
    return `outreach: ${result}`
  }
  if (action.kind === 'execute-goal' && action.goal) {
    const result = await deps.executeGoal(action.goal, agentId, action.selfCheckBias)
    recordTokenUsage(deps.getDb(), now, TOKEN_COST.executeGoal)
    log.info(`[handleEvolutionTick] agent=${agentId} execute-goal goalId=${action.goal.id} result=${result}`)
    return `execute-goal: ${result}`
  }
  if (action.kind === 'reflect') {
    const result = await deps.reflect(agentId)
    recordTokenUsage(deps.getDb(), now, TOKEN_COST.reflect)
    log.info(`[handleEvolutionTick] agent=${agentId} reflect result=${result}`)
    return `reflect: ${result}`
  }
  if (action.kind === 'diary') {
    const result = await deps.writeDiary(agentId)
    recordTokenUsage(deps.getDb(), now, TOKEN_COST.writeDiary)
    log.info(`[handleEvolutionTick] agent=${agentId} diary result=${result}`)
    return `diary: ${result}`
  }
  return 'unknown'
}

/**
 * 播种 evolution tick cron job（幂等）。
 *
 * 始终启用（enabled=1）：心跳除了承担自主进化行为（日记/反思/学习目标）外，
 * 还承担云同步冲突处理（system-maintenance 目标）的系统维护职责。
 * 云同步冲突分支在 handleEvolutionTick 最前面执行，不依赖自主进化开关。
 * interval_ms 读 readSettings().tickIntervalMinutes（设置页改动后重播一次即生效）。
 */
export function ensureEvolutionCronJobSeeded(db: DatabaseAdapter, _isEnabled: boolean): void {
  try {
    const intervalMs = readSettings(db).tickIntervalMinutes * 60_000
    const existing = db
      .prepare<{ id: string }>(`SELECT id FROM local_cron_jobs WHERE id = ?`)
      .get(EVOLUTION_TICK_CRON_ID)

    if (existing) {
      // 自愈：__evolution_tick__ 是魔法指令，只能由 companion 拦截（agent_id 必须为 NULL）。
      // 若被改成 agent 驱动（agent_id 非空），cron 会把它当真实 prompt 驱动 assistant，导致 tick 失效。
      // 这里每次启动强制复位为 companion 指令形态。
      // 始终启用（enabled=1）：心跳同时承担云同步冲突的系统维护职责。
      db.prepare(
        `UPDATE local_cron_jobs SET enabled = 1, interval_ms = ?, agent_id = NULL,
         schedule_type = 'every', schedule_expr = '',
         active_hour_start = NULL, active_hour_end = NULL, notify_targets = NULL
         WHERE id = ?`,
      ).run(intervalMs, EVOLUTION_TICK_CRON_ID)
      return
    }

    const now = Date.now()
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at)
       VALUES (?, ?, ?, NULL, 'every', '', ?, ?, 1, ?)`,
    ).run(
      EVOLUTION_TICK_CRON_ID,
      EVOLUTION_TICK_NAME,
      EVOLUTION_TICK_INSTRUCTION,
      now,
      intervalMs,
      now,
    )
    log.info(`[ensureEvolutionCronJobSeeded] 新建 job id=${EVOLUTION_TICK_CRON_ID} intervalMs=${intervalMs}`)
  } catch (err) {
    log.error('[ensureEvolutionCronJobSeeded] 失败:', err)
  }
}
