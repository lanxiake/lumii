/**
 * 自主进化心跳 tick 主逻辑（Windows 客户端专用）
 *
 * 对应设计文档 10 §4：每个 tick 走「感知 → 决策 → 执行」。
 * - 感知与决策是纯逻辑，放 agent-runtime 包（tick-signals.ts）
 * - 执行动作（落独白 / 跑目标 / 发消息 / 反思）在本文件，由 bridge 注入副作用
 *
 * 本文件同时负责播种 evolution tick 的 cron job（'every' + 10 分钟间隔）。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import {
  collectTickSignals,
  decideAction,
  TICK_INTERVAL_MS,
  TOKEN_COST,
  recordTokenUsage,
  type ApprovedGoalSignal,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

const EVOLUTION_TICK_CRON_ID = 'autonomous-tick'
const EVOLUTION_TICK_NAME = '自主进化心跳'
const EVOLUTION_TICK_INSTRUCTION = '__evolution_tick__'
const EVOLUTION_AGENT_ID = 'assistant'

/** evolution tick 依赖的副作用注入（由 bridge 在装配时提供） */
export interface EvolutionTickDeps {
  getDb: () => DatabaseAdapter
  isAutonomousEnabled: () => boolean
  hasActiveUserTurn: () => boolean
  /** 往 evolution:main 会话追加一条内心独白（内部负责 ensureConversationExists） */
  appendEvolutionMessage: (text: string) => void
  /** 执行一个已批准目标（复用 bridge 的驱动能力 + 工具白名单护栏） */
  executeGoal: (goal: ApprovedGoalSignal) => Promise<string>
  /** 发送一条主动消息（proactive-message 目标，走系统通知 + 预算计数） */
  sendOutreach: (goal: ApprovedGoalSignal) => Promise<string>
  /** 触发一次自我反思（复用已装配的 ReflectionEngine） */
  reflect: () => Promise<string>
  /** 写一篇今日日记（LLM 生成 + 落 evolution:main） */
  writeDiary: () => Promise<string>
  /** 当前时间（可注入，默认 new Date()；测试用于固定静默时段） */
  now?: () => Date
}

/**
 * 执行一次心跳 tick。
 *
 * 全程 try-catch，任何异常只记日志并返回 error 字符串，绝不抛给 cron 调度层。
 * 返回值写入 local_cron_runs.summary，供定时任务页查看。
 */
export async function handleEvolutionTick(deps: EvolutionTickDeps): Promise<string> {
  try {
    if (!deps.isAutonomousEnabled()) return 'skipped: disabled'
    if (deps.hasActiveUserTurn()) return 'skipped: user turn in progress'

    const now = deps.now?.() ?? new Date()
    const signals = collectTickSignals(deps.getDb(), EVOLUTION_AGENT_ID, now)
    const action = decideAction(signals)

    if (action.kind === 'idle') {
      log.info(`[handleEvolutionTick] idle reason=${action.reason}`)
      return 'idle'
    }
    if (action.kind === 'outreach' && action.goal) {
      const result = await deps.sendOutreach(action.goal)
      log.info(`[handleEvolutionTick] outreach goalId=${action.goal.id} result=${result}`)
      return `outreach: ${result}`
    }
    if (action.kind === 'execute-goal' && action.goal) {
      const result = await deps.executeGoal(action.goal)
      recordTokenUsage(deps.getDb(), now, TOKEN_COST.executeGoal)
      log.info(`[handleEvolutionTick] execute-goal goalId=${action.goal.id} result=${result}`)
      return `execute-goal: ${result}`
    }
    if (action.kind === 'reflect') {
      const result = await deps.reflect()
      recordTokenUsage(deps.getDb(), now, TOKEN_COST.reflect)
      log.info(`[handleEvolutionTick] reflect result=${result}`)
      return `reflect: ${result}`
    }
    if (action.kind === 'diary') {
      const result = await deps.writeDiary()
      recordTokenUsage(deps.getDb(), now, TOKEN_COST.writeDiary)
      log.info(`[handleEvolutionTick] diary result=${result}`)
      return `diary: ${result}`
    }
    return 'unknown'
  } catch (err) {
    log.error('[handleEvolutionTick] 失败:', err)
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * 播种 evolution tick cron job（幂等）。enabled 跟随 autonomous.enabled 开关，
 * interval_ms 读 TICK_INTERVAL_MS（Step 7 参数化后由设置页覆盖）。
 */
export function ensureEvolutionCronJobSeeded(db: DatabaseAdapter, isEnabled: boolean): void {
  try {
    const existing = db
      .prepare<{ id: string }>(`SELECT id FROM local_cron_jobs WHERE id = ?`)
      .get(EVOLUTION_TICK_CRON_ID)

    if (existing) {
      db.prepare(
        `UPDATE local_cron_jobs SET enabled = ?, interval_ms = ? WHERE id = ?`,
      ).run(isEnabled ? 1 : 0, TICK_INTERVAL_MS, EVOLUTION_TICK_CRON_ID)
      return
    }

    const now = Date.now()
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at)
       VALUES (?, ?, ?, NULL, 'every', '', ?, ?, ?, ?)`,
    ).run(
      EVOLUTION_TICK_CRON_ID,
      EVOLUTION_TICK_NAME,
      EVOLUTION_TICK_INSTRUCTION,
      now,
      TICK_INTERVAL_MS,
      isEnabled ? 1 : 0,
      now,
    )
    log.info(`[ensureEvolutionCronJobSeeded] 新建 job id=${EVOLUTION_TICK_CRON_ID}`)
  } catch (err) {
    log.error('[ensureEvolutionCronJobSeeded] 失败:', err)
  }
}
