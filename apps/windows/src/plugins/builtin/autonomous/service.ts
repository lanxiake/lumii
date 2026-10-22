import type { DatabaseAdapter, ReflectionOutput } from '@mtbot/agent-runtime'

import type { EvolutionTickDeps } from './evolution-tick'
import type { EvolutionPersistDeps } from './evolution-memory-persist'
import type { PlannerWiringDeps } from './planner-wiring'
import type { ApprovedGoalSignal } from '@mtbot/agent-runtime'

/**
 * 自主进化对核心暴露的**全部**能力。
 *
 * 核心（bridge / IPC / 命令）只通过 `S.autonomous` 拿它：插件停用后服务从容器消失，
 * 所有调用点变成 no-op —— 心跳不再跑、不给实例注入 Prompt 变体、不记反馈信号、
 * 不播种 `autonomous-tick`。运行期状态（协调器、反思引擎、当前 db）都在插件内部。
 */
export interface AutonomousService {
  /** 系统通知出口（bridge 注入，缺省写日志） */
  setNotifier(notify: (title: string, body: string, conversationId?: string) => void): void
  /** 由 bridge 在库就绪后调用；callLLM 缺省时只有反射以外的功能可用 */
  init(db: DatabaseAdapter, callLLM?: (prompt: string) => Promise<string>): void
  shutdown(): Promise<void>

  readEnabled(db: DatabaseAdapter): boolean
  /** 总开关与 cron 联动：关时挂起 `agent-self:*`，开时恢复 */
  syncManagedCronJobs(db: DatabaseAdapter, enabled: boolean): void
  /** 读开关并同步一次（核心最常见的组合，避免调用方自己拼） */
  syncCronFromDb(db: DatabaseAdapter): void

  /** 心跳 tick（cron `__evolution_tick__` 触发） */
  handleTick(deps: EvolutionTickDeps): Promise<string>
  reflect(
    agentId: string,
    reason: 'scheduled' | 'low-satisfaction' | 'user-request',
  ): Promise<ReflectionOutput>
  notifyNewPendingGoals(): void

  selectPromptVariantForSession(
    conversationId: string,
  ): Promise<{ variantId: string; variantText: string } | null>
  recordFeedbackSignal(conversationId: string, kind: 'edit' | 'resend' | 'abort'): void
  notifyTurnEnd(conversationId: string): Promise<void>
  notifyGoalApproved(goalId: string): boolean

  shouldFallbackPlan(db: DatabaseAdapter, agentId: string, now: Date): boolean
  runPlanner(deps: PlannerWiringDeps, agentId: string): Promise<unknown>
  persistLearningOutcome(
    deps: EvolutionPersistDeps,
    goal: ApprovedGoalSignal,
    output: string,
    agentId?: string,
  ): void
  recordProactiveAction(
    memoryManager: EvolutionPersistDeps['memoryManager'],
    goal: ApprovedGoalSignal,
    outcome: string,
    agentId?: string,
  ): void
}
