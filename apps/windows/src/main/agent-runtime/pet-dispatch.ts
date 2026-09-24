/**
 * 宠物侧派发循环（Windows 客户端专用）
 *
 * 对应宠物智能化实施计划 T3.3。**这里只做三件事**：找活、让路、执行。
 * 决策语义刻意不复用自主进化的心跳（`evolution-tick.ts`）——那份的优先级是
 * assistant 的口味（主动消息 > 目标 > 日记 > 反思），而宠物只有"用户交代的一件事"。
 *
 * ---------------------------------------------------------------------------
 * 为什么不把 `pet:*` 加进 `listAutonomousAgentIds()`
 * ---------------------------------------------------------------------------
 * 加进去只需一行，但会连带继承四件不属于宠物的事（逐条查过代码）：
 *
 * | 继承物 | 后果 |
 * |---|---|
 * | `computeReflectionDue` **没有** agent 守卫 | 宠物会被拉去做元认知反思 |
 * | `decideAction` 的第一优先级是 `proactive-message` | 宠物的话会顶掉助手的主动消息 |
 * | token / outreach 预算键是全局的 | 宠物跑目标记在助手账上（T3.2 要拆的就是这个） |
 * | `hasActiveUserTurn` 在 tick 入口**全局判一次** | 用户一开聊，宠物的目标也跑不了 |
 *
 * 最后一条最要命：第五期要的是"点一下 <200ms 有响应"，而心跳是十分钟一拍。
 * 宠物的触发源与心跳的节拍本来就不匹配。**要的是派发 + 单飞锁，不是再来一个自主心跳。**
 *
 * ---------------------------------------------------------------------------
 * 触发方式：一条自己的 cron 任务（`pet-dispatch` / `__pet_dispatch__`）
 * ---------------------------------------------------------------------------
 * 与 `autonomous-tick` 同一手法：companion 魔法指令 + 代码播种。这样换来三件事——
 * 1. 有**真正的常驻消费者**，不是导出了没人调（本仓库最忌讳的那种死代码）；
 * 2. 手动触发不用新开控制口：`cron:run pet-dispatch` 已在白名单里（三期验收就是"手动派一个目标"）；
 * 3. 用户能在定时任务页看到并暂停它。
 *
 * **它不跟随自主进化总开关**：宠物是独立 Agent（设计 §3.7），关掉助手的自主进化不该让宠物停摆。
 * 等第五期 T5.9 有「是否允许宠物主动做事」的开关后，再改由那个开关接管（用户自管是暂态）。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { listDuePetGoals, type PetGoalSignal } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

const PET_DISPATCH_CRON_ID = 'pet-dispatch'
const PET_DISPATCH_NAME = '桌宠派发'
/** companion 魔法指令（`local-companion-handler.ts` 的 COMPANION_INSTRUCTIONS） */
export const PET_DISPATCH_INSTRUCTION = '__pet_dispatch__'
/**
 * 派发节拍：5 分钟。
 *
 * 比自主进化心跳（10 分钟）密一倍——宠物目标的 `scheduled_for` 是"用户让它待会儿去看一眼"，
 * 迟到十分钟就不像话了；而宠物目标本来就少，一轮查询是一条走索引的 SELECT。
 * 第五期"点一下就有反应"走的是**直接调用**，不靠这个节拍，所以它不需要更密。
 */
const PET_DISPATCH_INTERVAL_MS = 5 * 60_000

/** 派发循环依赖的副作用（由 bridge 装配时注入） */
export interface PetDispatchDeps {
  getDb: () => DatabaseAdapter
  /** 退出清场中——此时每次读库都必抛，最先判 */
  isShuttingDown?: () => boolean
  /**
   * 真实用户回合进行中 → 让路。
   *
   * ⚠ 这里注入的是 bridge 已有的那份实现（`hasActiveUserTurn`），**不是照抄**：
   * 它已经把 `cron:%` 与 `evolution:%` 排除掉了（历史坑：后台会话被误判成用户回合），
   * 而宠物的会话正是 `evolution:pet:<模型ID>`——天然落在那条排除里，宠物的流式不会被自己判成用户回合。
   * 计划里那句"不要照抄这个函数的实现，只照抄思路"说的就是这个。
   */
  hasActiveUserTurn?: () => boolean
  /** 单飞锁（T3.4）：当前正在跑的宠物是哪个；没有则 null */
  findActivePetAgent: () => string | null
  /** 执行一个宠物目标，返回结果摘要（成功/失败由它自己落库） */
  executePetGoal: (goal: PetGoalSignal) => Promise<string>
  /** 当前时间（可注入，供测试固定排期） */
  now?: () => Date
}

/**
 * 跑一轮宠物派发。
 *
 * 全程 try-catch，任何异常只记日志并返回错误串，绝不抛给 cron 调度层
 * （与 `handleEvolutionTick` 同一条约定：返回值写进 `local_cron_runs.summary`）。
 *
 * **一轮最多执行一个目标**：单飞锁是"一次一个"，不是"一次一批"。
 * 宠物不是流水线，用户看到的是"它去做了一件事"，排队的事留给下一拍。
 */
export async function runPetDispatch(deps: PetDispatchDeps): Promise<string> {
  if (deps.isShuttingDown?.()) {
    log.warn('[runPetDispatch] 退出清场中，跳过本次派发')
    return 'skipped: shutting down'
  }
  try {
    if (deps.hasActiveUserTurn?.()) return 'skipped: user turn in progress'

    const goals = listDuePetGoals(deps.getDb(), deps.now?.() ?? new Date())
    if (goals.length === 0) return 'idle: no-pet-goal'

    const busy = deps.findActivePetAgent()
    if (busy) return `skipped: busy (${busy})`

    const goal = goals[0]
    log.info(
      `[runPetDispatch] 派发宠物目标 agent=${goal.agentId} goalId=${goal.id} 待办剩余=${goals.length - 1}`,
    )
    const result = await deps.executePetGoal(goal)
    log.info(`[runPetDispatch] agent=${goal.agentId} goalId=${goal.id} result=${result}`)
    return `pet-goal: ${result}`
  } catch (err) {
    log.error('[runPetDispatch] 失败:', err)
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * 播种宠物派发 cron job（幂等）。
 *
 * 与 `ensureEvolutionCronJobSeeded` 的两处差别，都是刻意的：
 * 1. **enabled 不跟随任何开关**——首启置 1，之后**不覆盖**（用户可在任务页暂停）。
 *    自主进化心跳每次启动都把 enabled 强拉回开关值，那是它被总开关接管的表现；
 *    宠物还没有那个开关（T5.9 才有），提前替用户决定"关掉"是错的。
 * 2. **形态仍然自愈**（interval / agent_id=NULL / every / 无生效窗口）：
 *    这个 job 若被改成 agent 驱动，cron 会把 `__pet_dispatch__` 当真实 prompt 喂给某个 Agent，
 *    与 `__evolution_tick__` 同一个坑。
 */
export function ensurePetDispatchCronJobSeeded(db: DatabaseAdapter): void {
  try {
    const existing = db
      .prepare<{ id: string }>(`SELECT id FROM local_cron_jobs WHERE id = ?`)
      .get(PET_DISPATCH_CRON_ID)

    if (existing) {
      db.prepare(
        `UPDATE local_cron_jobs SET interval_ms = ?, agent_id = NULL,
         schedule_type = 'every', schedule_expr = '',
         active_hour_start = NULL, active_hour_end = NULL, notify_targets = NULL
         WHERE id = ?`,
      ).run(PET_DISPATCH_INTERVAL_MS, PET_DISPATCH_CRON_ID)
      return
    }

    const now = Date.now()
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at)
       VALUES (?, ?, ?, NULL, 'every', '', ?, ?, 1, ?)`,
    ).run(PET_DISPATCH_CRON_ID, PET_DISPATCH_NAME, PET_DISPATCH_INSTRUCTION, now, PET_DISPATCH_INTERVAL_MS, now)
    log.info(`[ensurePetDispatchCronJobSeeded] 新建 job id=${PET_DISPATCH_CRON_ID} intervalMs=${PET_DISPATCH_INTERVAL_MS}`)
  } catch (err) {
    log.error('[ensurePetDispatchCronJobSeeded] 失败:', err)
  }
}
