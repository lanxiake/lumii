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
import { seedCompanionCronJob } from './companion-cron-seed'

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
  /**
   * 是否正在退出清场（库已关闭）。缺省视为否——旧注入点不受影响。
   *
   * tick 的动作（executeGoal 等）可能跑几十秒，返回时进程可能已在关库；
   * 记账写库前先问这里，避免把已完成的心跳炸成 "Database not initialized"（2026-09-20 退出实测）。
   */
  isShuttingDown?: () => boolean
  /** 驱动待处理的云同步冲突目标（系统维护，独立于自主进化开关与能量/预算门闩）。
   *  由 bridge 注入，在心跳 tick 中检测到 type='system-maintenance' 的 executing 目标时调用。
   *  冲突的主路径是 index.ts 的 onConflictDetected / SyncScheduler.setOnConflictPending，
   *  这里只是心跳运行期间的快速通道。
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
  // 退出清场检查点（最先）：库已关时下面每个 deps 回调一碰 DB 就抛
  if (deps.isShuttingDown?.()) {
    log.warn('[handleEvolutionTick] 退出清场中，跳过本次心跳')
    return 'skipped: shutting down'
  }
  try {
    // ── 云同步冲突目标优先处理 ──
    // 系统维护任务（assistant 专属），独立于自主进化开关 / 能量 / token 预算 / 用户对话阻塞。
    // 由 bridge 注入的 driveConflictGoal 负责找到 executing 的 system-maintenance 目标
    // 并用受限实例 + 冲突工具驱动 Agent 解决。
    // 注意：这不是冲突处理的必经路径——正常由 index.ts 的 onConflictDetected（立即驱动）
    // 与 SyncScheduler.setOnConflictPending（周期重试）承担；心跳关闭后二者仍独立工作。
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
    // 主体列表：**没提供 deps** 时回落默认（测试与旧装配路径）；
    // **提供了但为空**就是"没有主体要跑"，不再回落。
    //
    // ⚠ 2026-09-24 主体迁移时这里改过一次：原先写的是
    // `requested.length > 0 ? requested : DEFAULT`——空数组会被换成 `['assistant']`，
    // 于是"把 assistant 从列表里摘掉"**等于没摘**（它从后门又回来了，而且不报错）。
    // 空列表现在是一个明确的返回值，日志里能看见。
    const agentIds = deps.listAutonomousAgentIds
      ? deps.listAutonomousAgentIds()
      : [...DEFAULT_AUTONOMOUS_AGENT_IDS]
    if (agentIds.length === 0) return 'idle: no autonomous agents'

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
  // 检查点：多 Agent 循环逐个体检时，前一个 Agent 跑完可能已到关库边界
  if (deps.isShuttingDown?.()) {
    log.warn(`[handleEvolutionTick] 退出清场中，跳过 agent=${agentId}`)
    return 'skipped: shutting down'
  }
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
    recordUsageIfLive(deps, now, TOKEN_COST.executeGoal, agentId)
    log.info(`[handleEvolutionTick] agent=${agentId} execute-goal goalId=${action.goal.id} result=${result}`)
    return `execute-goal: ${result}`
  }
  if (action.kind === 'reflect') {
    const result = await deps.reflect(agentId)
    recordUsageIfLive(deps, now, TOKEN_COST.reflect, agentId)
    log.info(`[handleEvolutionTick] agent=${agentId} reflect result=${result}`)
    return `reflect: ${result}`
  }
  if (action.kind === 'diary') {
    const result = await deps.writeDiary(agentId)
    recordUsageIfLive(deps, now, TOKEN_COST.writeDiary, agentId)
    log.info(`[handleEvolutionTick] agent=${agentId} diary result=${result}`)
    return `diary: ${result}`
  }
  return 'unknown'
}

/**
 * token 记账守卫：动作（executeGoal 等）跑完时进程可能已在关库——
 * 此刻 recordTokenUsage 必抛 "Database not initialized"，把一次已完成的心跳炸成失败。
 * 记账只是预算簿记，停机中丢一条无妨。
 */
function recordUsageIfLive(
  deps: EvolutionTickDeps,
  now: Date,
  tokens: number,
  agentId: string,
): void {
  if (deps.isShuttingDown?.()) {
    log.warn(`[handleEvolutionTick] 退出清场中，跳过 token 记账 agent=${agentId}`)
    return
  }
  recordTokenUsage(deps.getDb(), agentId, now, tokens)
}

/**
 * 播种 evolution tick cron job（幂等）。
 *
 * enabled 跟随自主进化总开关：关闭时任务显示为已暂停（不再每 10 分钟空转），
 * 重新开启时由同一次同步恢复。云同步冲突的处理不依赖本任务——
 * 冲突在 index.ts 的 setOnConflictDetected（立即驱动）与
 * SyncScheduler.setOnConflictPending（周期重试）两条独立路径上。
 *
 * interval_ms 读 readSettings().tickIntervalMinutes（设置页改动后重播一次即生效）。
 */
export function ensureEvolutionCronJobSeeded(db: DatabaseAdapter, isEnabled: boolean): void {
  seedCompanionCronJob(db, {
    id: EVOLUTION_TICK_CRON_ID,
    name: EVOLUTION_TICK_NAME,
    instruction: EVOLUTION_TICK_INSTRUCTION,
    intervalMs: readSettings(db).tickIntervalMinutes * 60_000,
    enabledOnCreate: isEnabled ? 1 : 0,
    // 自主进化心跳被总开关接管：每次启动都把 enabled 强拉回开关值
    enabledOnReseed: isEnabled ? 1 : 0,
  })
}
