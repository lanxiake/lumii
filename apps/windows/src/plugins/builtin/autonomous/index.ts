import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import {
  initAutonomousRuntime,
  notifyAutonomousGoalApproved,
  notifyAutonomousTurnEnd,
  notifyNewPendingGoals,
  readAutonomousEnabled,
  recordFeedbackSignal,
  reflectAutonomous,
  selectPromptVariantForSession,
  setAutonomousNotifier,
  shutdownAutonomousRuntime,
} from './autonomous-wiring'
import { syncAutonomousManagedCronJobs } from './autonomous-cron-linkage'
import { handleEvolutionTick } from './evolution-tick'
import { persistLearningOutcome, recordProactiveAction } from './evolution-memory-persist'
import { runPlanner, shouldFallbackPlan } from './planner-wiring'
import { registerAutonomousIpcHandlers, setAutonomousIpcDeps } from './autonomous-ipc'
import type { AutonomousService } from './service'

/**
 * 自主进化（实验功能）。
 *
 * 插件拥有：运行时装配（协调器 / 反思引擎 / Prompt 进化）、心跳 tick 与 cron 播种、
 * 开关与 cron 联动、反馈信号、20 个 `autonomous:*` IPC，以及渲染层仪表板。
 *
 * 核心只认 `S.autonomous`：停用后服务消失 ⇒ bridge 的心跳不再跑、实例不再注入
 * Prompt 变体、`autonomous-tick` 不再播种、IPC 随作用域摘掉、设置页入口消失。
 *
 * 启停细节：运行时的 db 与 callLLM 由 bridge 在启动时交进来，这里记住一份——
 * 停用时用同一份 db 把托管 cron 挂起（否则已播种的 tick 还会每 10 分钟醒一次），
 * 再启用时就地重新装配，不必重启客户端。
 */
let lastInit: { db: DatabaseAdapter; callLLM?: (prompt: string) => Promise<string> } | null = null

const service: AutonomousService = {
  setNotifier: setAutonomousNotifier,
  init: (db, callLLM) => {
    lastInit = { db, callLLM }
    initAutonomousRuntime(db, callLLM)
  },
  shutdown: shutdownAutonomousRuntime,

  readEnabled: readAutonomousEnabled,
  syncManagedCronJobs: syncAutonomousManagedCronJobs,
  syncCronFromDb: (db) => syncAutonomousManagedCronJobs(db, readAutonomousEnabled(db)),

  handleTick: handleEvolutionTick,
  reflect: reflectAutonomous,
  notifyNewPendingGoals,

  selectPromptVariantForSession,
  recordFeedbackSignal,
  notifyTurnEnd: notifyAutonomousTurnEnd,
  notifyGoalApproved: notifyAutonomousGoalApproved,

  shouldFallbackPlan,
  runPlanner,
  persistLearningOutcome,
  recordProactiveAction,
}

export const autonomousExtension = {
  manifest: {
    id: 'com.lumii.autonomous',
    name: '自主进化',
    version: '0.1.0',
    description: '自主目标规划与执行、心跳反思、能力评测与满意度统计',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.autonomous',
    apply(ctx) {
      // 目标审批等少数 handler 需要写 app.json 的 autonomousAgents
      setAutonomousIpcDeps({ getConfigManager: () => ctx.get(S.config)?.get() ?? null })
      registerAutonomousIpcHandlers({
        handle: (channel, listener) => ctx.registerIpc?.(channel, listener),
      })

      // 重新启用：bridge 不会再调一次 init，这里就地重建运行时并恢复托管 cron
      if (lastInit) {
        initAutonomousRuntime(lastInit.db, lastInit.callLLM)
        try {
          syncAutonomousManagedCronJobs(lastInit.db, readAutonomousEnabled(lastInit.db))
        } catch {
          /* 同上：启用路径失败只影响 cron，运行时已重建 */
        }
      }

      ctx.provide(S.autonomous, service)

      ctx.effect(() => {
        // 停用：先挂起托管 cron（`autonomous-tick` 与 `agent-self:*`），再关运行时。
        // 顺序重要——反过来的话，挂起动作会经由已关闭的协调器。
        if (lastInit) {
          try {
            syncAutonomousManagedCronJobs(lastInit.db, false)
          } catch {
            /* 关库/表缺等边缘情况：停机路径不抛 */
          }
        }
        void shutdownAutonomousRuntime()
      })
    },
  }),
}
