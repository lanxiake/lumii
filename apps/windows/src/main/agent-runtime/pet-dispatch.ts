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
 * | `decideAction` 的第一优先级是 `proactive-message` | 宠物的话会顶掉主动消息 |
 * | ~~token / outreach 预算键是全局的~~ | **已修**（T3.2 拆了键）；留着是为了说明当时为什么不能进 |
 * | `hasActiveUserTurn` 在 tick 入口**全局判一次** | 用户一开聊，宠物的目标也跑不了 |
 *
 * 最后一条最要命：第五期要的是"点一下 <200ms 有响应"，而心跳是十分钟一拍。
 * 宠物的触发源与心跳的节拍本来就不匹配。**要的是派发 + 单飞锁，不是再来一个自主心跳。**
 *
 * ⚠ **2026-09-24 主体迁移之后，这张表依然有效**：`listAutonomousAgentIds()` 里
 * 现在**只剩系统 Agent**（`assistant` 已摘掉，见第六期 T6.4），但宠物仍然**不走**这条心跳——
 * 上面四条里的第一、二、四条一条都没变，而"触发源与节拍不匹配"更是与列表里放了谁无关。
 * 宠物要走自己的认知链（第七期的 `pet-evolve`：反思 + 排期 + 日记，低频且让路于用户回合）。
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
import {
  MAX_PET_GOALS_PER_DAY,
  MAX_PET_TOKENS_PER_DAY,
  TOKEN_COST,
  canSpendTokens,
  countPetRunsToday,
  finalizeGoal,
  listDuePetGoals,
  readTodayTokenUsage,
  recordTokenUsage,
  type PetGoalSignal,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'
import { seedCompanionCronJob, setCompanionCronJobEnabled } from './companion-cron-seed'

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

/**
 * 进程内的"这一拍还在飞"标记（2026-09-24 复审补的第二道锁）。
 *
 * `findActivePetAgent` 那把单飞锁**挡不住同时进来的两拍**：它在第一个 await **之前**
 * 求值，而实例要等 `createInstance` 里的若干 await 之后才注册进注册表——那个窗口里
 * 第二拍看到的仍是"没有宠物实例"，于是同一个目标被跑两遍（两次模型往返、两次记账、
 * 两条回执），而且 `finalizeGoal` 是无条件 UPDATE，后跑完的那次还能把 `completed`
 * 覆写成 `failed`。
 *
 * 两个调用点（cron 心跳 5 分钟一拍、受理成功后立刻踢的那一脚）走的是同一个函数，
 * 所以锁摆在这里就把两条入口都盖住了。**跳过是安全的**：受理侧已经保证"有活在跑时不收新活"，
 * 能撞上的只有"同一件事被两拍同时看见"。
 */
let dispatchInFlight = false

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
  /**
   * 把一个**没跑起来**的目标的结局告诉用户：写进宠物会话 + 推气泡事件（+ 落终态由本模块做）。
   *
   * **必须注入**：回执只写在 `executePetGoal` 成功路径上的话，另两条路用户侧零感知
   * （三期的缺口）。实现不该抛——抛了会把一轮派发炸掉，而回执只是播报。
   */
  reportGoalResult: (goal: PetGoalSignal, ok: boolean, text: string) => void
  /** 当前时间（可注入，供测试固定排期） */
  now?: () => Date
  /**
   * 「允许宠物主动做事」总开关（五期 T5.9）。缺省视为开。
   *
   * **判在入口而不是判在 enabled 上**：那个 job 的 enabled 是用户能在任务页自己按的，
   * 两处都判才是稳的（理由见 {@link syncPetDispatchJobEnabled}）。
   */
  isPetTaskEnabled?: () => boolean
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
  // 第二条锁：见 `dispatchInFlight` 的注释。判在最前面——退出清场那条也算"已经进不来了"
  if (dispatchInFlight) {
    log.warn('[runPetDispatch] 上一拍还没收尾，跳过本次')
    return 'skipped: already dispatching'
  }
  dispatchInFlight = true
  try {
    return await runPetDispatchInner(deps)
  } finally {
    dispatchInFlight = false
  }
}

async function runPetDispatchInner(deps: PetDispatchDeps): Promise<string> {
  if (deps.isShuttingDown?.()) {
    log.warn('[runPetDispatch] 退出清场中，跳过本次派发')
    return 'skipped: shutting down'
  }
  try {
    /**
     * 「允许宠物主动做事」总开关（五期 T5.9），判在最前面。
     *
     * 与 `enabled` 那道**都要有**（见 {@link syncPetDispatchJobEnabled}）：
     * 这里判的是"此刻用户的意愿"，那道判的是"调度器要不要跑"。
     * 关掉之后留在 `executing` 里的目标**不动**——不是丢弃，是等总开关再打开
     * （"已经在路上的那件会跑完"指的是正在跑的那一次，不是排队里的）。
     */
    if (deps.isPetTaskEnabled && !deps.isPetTaskEnabled()) {
      return 'skipped: pet task disabled'
    }
    if (deps.hasActiveUserTurn?.()) return 'skipped: user turn in progress'

    const goals = listDuePetGoals(deps.getDb(), deps.now?.() ?? new Date())
    if (goals.length === 0) return 'idle: no-pet-goal'

    const busy = deps.findActivePetAgent()
    if (busy) return `skipped: busy (${busy})`

    const goal = goals[0]
    const now = deps.now?.() ?? new Date()

    // 两道**硬闸门**（T3.2 的常量，判定落在这里——见 config.ts 的注释）。
    // 顺序：先数次数再数预算，因为次数便宜、且"今天点够了"比"预算烧完了"对用户更好解释。
    const refusal = checkPetGates(deps.getDb(), goal.agentId, now)
    if (refusal) {
      // 拒了就要有个结果：落终态（不能让它烂在 executing 里每 5 分钟被捞一次）
      // **而且要有回执**——被拒的恰恰是"用户自己交代的事"，只写一条 WARN 的话
      // 用户唯一知情途径是去定时任务页翻 `local_cron_runs.summary`。
      log.warn(`[runPetDispatch] 拒绝 agent=${goal.agentId} goalId=${goal.id}：${refusal}`)
      finishWithoutRun(deps, goal, refusal)
      return `refused: ${refusal}`
    }

    log.info(
      `[runPetDispatch] 派发宠物目标 agent=${goal.agentId} goalId=${goal.id} 待办剩余=${goals.length - 1}`,
    )
    let result: string
    try {
      result = await deps.executePetGoal(goal)
    } catch (err) {
      /**
       * 执行抛错这条路**必须自己收尾**（2026-09-24 修）。
       *
       * 原来只记日志 + 返回 error 串：目标永远停在 `executing`（`scheduled_for` 已到期），
       * 5 分钟后被 `listDuePetGoals` 再捞起来 —— 无限重跑、无退避。而且**两道闸门都拦不住**：
       * 次数门数的是"跑过几条"（重试不增加），预算门读的记账恒为 0（抛错那条路没记账）。
       * 一笔挂住就是一个死循环。
       *
       * 记账也要照做：这一轮**真跑过**（模型往返发生过），钱是花了的。
       */
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`[runPetDispatch] agent=${goal.agentId} goalId=${goal.id} 执行失败:`, msg)
      recordTokensIfLive(deps, goal.agentId)
      finishWithoutRun(deps, goal, msg)
      return `error: ${msg}`
    }
    recordTokensIfLive(deps, goal.agentId)
    log.info(`[runPetDispatch] agent=${goal.agentId} goalId=${goal.id} result=${result}`)
    return `pet-goal: ${result}`
  } catch (err) {
    log.error('[runPetDispatch] 失败:', err)
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * 收尾一个**没能跑起来**的目标：落终态 + 发回执。
 *
 * 「没能跑起来」= 被硬闸门拒 / 执行抛错。**跑起来了**那条由 bridge 的 `executePetGoal`
 * 自己收尾——只有它知道成没成。
 *
 * 两步各自兜异常：这是派发循环的最后一道防线，它自己再抛就没人接了；
 * 而 `finalizeGoal` 落不下去（库已关）时，回执更得发出去——那是用户唯一的知情途径。
 * 两步与调用顺序一致：先落库（终态是硬要求），再播报（丢了只是少一句话）。
 */
function finishWithoutRun(deps: PetDispatchDeps, goal: PetGoalSignal, reason: string): void {
  try {
    finalizeGoal(deps.getDb(), goal.id, { success: false, output: reason })
  } catch (err) {
    log.error(
      `[runPetDispatch] 终态落库失败 goalId=${goal.id}:`,
      err instanceof Error ? err.message : err,
    )
  }
  try {
    deps.reportGoalResult(goal, false, reason)
  } catch (err) {
    log.error(
      `[runPetDispatch] 回执发送失败 goalId=${goal.id}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * 两道硬闸门的判定。超额返回可读的拒绝理由，未超额返回 null。
 *
 * **两道谁先到算谁**（`config.ts` 的注释：5 × `TOKEN_COST.executeGoal` 与 40k 同量级）。
 * 预算那道用 `canSpendTokens` 判——与自主进化那条路**同一个函数**，
 * 不在这里重写一遍比较（两份实现迟早漂移，而这是安全闸门）。
 */
function checkPetGates(db: DatabaseAdapter, agentId: string, now: Date): string | null {
  const runsToday = countPetRunsToday(db, agentId, now)
  if (runsToday >= MAX_PET_GOALS_PER_DAY) {
    return `今日目标已用满（${runsToday}/${MAX_PET_GOALS_PER_DAY}）`
  }
  if (!canSpendTokens(db, agentId, now, TOKEN_COST.executeGoal, MAX_PET_TOKENS_PER_DAY)) {
    // 拒绝才多读一次拿可读数字：正常路径上不为日志多查一次库
    const tokensUsed = readTodayTokenUsage(db, agentId, now)
    return `今日预算不足（已用 ${tokensUsed}，本次需 ${TOKEN_COST.executeGoal}，上限 ${MAX_PET_TOKENS_PER_DAY}）`
  }
  return null
}

/**
 * token 记账守卫：动作跑完时进程可能已在关库（与 `evolution-tick.ts` 的
 * `recordUsageIfLive` 同一条约定——记账只是预算簿记，停机中丢一条无妨，
 * 但硬写会把一次已完成的心跳炸成 "Database not initialized" 失败）。
 *
 * **时间在这里现取**，不用派发开始时那个：一轮可能跨过本地零点（模型往返几分钟是常事），
 * 用旧时间会把这一笔记到**前一天**，于是今天的预算凭空多出一次、昨天多算一次
 * （跨零点那一拍的闸门判定也跟着错）。口径取"记账发生在哪一天"。
 */
function recordTokensIfLive(deps: PetDispatchDeps, agentId: string): void {
  if (deps.isShuttingDown?.()) return
  try {
    recordTokenUsage(deps.getDb(), agentId, deps.now?.() ?? new Date(), TOKEN_COST.executeGoal)
  } catch (err) {
    log.warn(`[runPetDispatch] token 记账失败 agent=${agentId}:`, err instanceof Error ? err.message : err)
  }
}

/**
 * 播种宠物派发 cron job（幂等）。
 *
 * 与 `ensureEvolutionCronJobSeeded` 的差别只有一处，是刻意的：
 * **播种时 enabled 不跟随任何开关**——首启置 1，之后**不覆盖**（用户可在任务页暂停）。
 * 自主进化心跳每次启动都把 enabled 强拉回开关值，那是它被总开关接管的表现。
 *
 * ⚠ 五期 T5.9 有了「允许宠物主动做事」开关之后，enabled 由
 * {@link syncPetDispatchJobEnabled} 单独同步（**启动时一次 + 设置变更时一次**），
 * 不走这条播种路径——播种只负责"job 存在且形态正确"，开关归开关。
 *
 * 形态（interval / agent_id=NULL / every / 无生效窗口）与它**共用** `seedCompanionCronJob`：
 * 那份 SQL 原本是逐行复制的，而复制出来的东西不会一起改——形态一旦漂移，
 * 这条 job 会被 cron 当成真实 prompt 喂给某个 Agent，与 `__evolution_tick__` 同一个坑。
 */
export function ensurePetDispatchCronJobSeeded(db: DatabaseAdapter): void {
  seedCompanionCronJob(db, {
    id: PET_DISPATCH_CRON_ID,
    name: PET_DISPATCH_NAME,
    instruction: PET_DISPATCH_INSTRUCTION,
    intervalMs: PET_DISPATCH_INTERVAL_MS,
    enabledOnCreate: 1,
    // 不传 enabledOnReseed → 保留库里的值（用户的暂停）
  })
}

/**
 * 「允许宠物主动做事」总开关 → job 的 enabled（五期 T5.9）。
 *
 * 实现已提到 `companion-cron-seed.ts` 的 {@link setCompanionCronJobEnabled}：
 * 七期 T7.4 之后宠物有**两条** job 跟同一个开关（派发与反思），
 * 而两者的同步逻辑一字不差——抄一份的下场是"加第三条时只改了一处"。
 *
 * ⚠ **启动时也同步一次**（见 bridge 的 `initialize`）。
 */
export function syncPetDispatchJobEnabled(db: DatabaseAdapter, enabled: boolean): void {
  setCompanionCronJobEnabled(db, PET_DISPATCH_CRON_ID, enabled)
}
