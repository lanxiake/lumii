import {
  finalizeGoal,
  type DatabaseAdapter,
  type PetGoalSignal,
} from '@mtbot/agent-runtime'

import { agentRuntimeLog as log } from '../bridge-utils'
import type { InstanceState } from '../bridge-instance-state'
import { recordPetPersonalityEvent } from '../pet-personality'
import { readPetTaskDimension, recordPetTaskOutcome } from '../pet-task-store'
import { withTimeout } from '../with-timeout'

/**
 * 宠物目标的单轮执行（从 `bridge.executePetGoal` 搬出来）。
 *
 * 搬出来的理由不是行数，是**可测**：这段 160 行里最要紧的是三个判据
 * （会话必须先于实例、实例 id 必须在 try 内赋值、`ok = 有正文 && 无错误`），
 * 它们各自有一条用事故换来的注释。原来埋在 4400 行的 bridge 私有方法里，
 * 一条单测都写不了。
 *
 * 依赖全部显式列出（11 个）：bridge 那边只剩一行组装的调用。
 */

/**
 * 宠物目标单轮执行超时（T3.3 派发循环）。
 *
 * 比同步冲突那 10 分钟短得多：宠物做的是"看一眼"级别的小事（`PET_MAX_TURNS = 20`），
 * 而用户就坐在桌面前等着看它说话——挂了五分钟的"还在跑"，体验上已经等于没做成。
 *
 * 与 `SYNC_CONFLICT_EXEC_TIMEOUT_MS` 同一条理由：不 settle 则 `finally` 不执行，
 * 实例（连同它的单飞锁）永久留在注册表里，之后每一拍都是 `skipped: busy`。
 */
export const PET_GOAL_EXEC_TIMEOUT_MS = 5 * 60 * 1000

export interface PetGoalRunnerDeps {
  db: DatabaseAdapter
  /** 宠物会话 id（与 agentId 一一对应） */
  conversationIdFor(agentId: string): string
  /** 会话不存在时补建：必须在建实例之前 */
  ensureConversation(agentId: string, conversationId: string): void
  createInstance(agentId: string, conversationId: string): Promise<string>
  prompt(instanceId: string, message: string): Promise<void>
  waitForIdle(instanceId: string): Promise<void>
  assistantOutput(instanceId: string): string | null
  instanceState(instanceId: string): InstanceState | undefined
  reportResult(
    goal: PetGoalSignal,
    ok: boolean,
    text: string,
    opts?: { userTurn?: string },
  ): void
  recordMood(event: 'pet_task_done' | 'pet_task_failed', agentId: string): void
  destroy(instanceId: string): void
}

export async function runPetGoal(
  goal: PetGoalSignal,
  deps: PetGoalRunnerDeps,
): Promise<string> {
  const { agentId } = goal
  const convId = deps.conversationIdFor(agentId)
  let instanceId: string | null = null
  try {
    /**
     * ⚠ 会话必须在**建实例之前**就位（2026-09-24 回归修复）。
     *
     * 这句话一度只留在 `reportPetGoalResult` 里——那意味着**第一次**在一条新会话上
     * 干活时（首次使用、换宠物模型、用户删过那条会话），整轮的落库全被跳过
     * （`bridge-agent-instance-events` 的两处守卫都按"会话不存在"处理），
     * 用户只看到开始和回执，中间干了什么一片空白。收尾那次补建治不了这个。
     */
    deps.ensureConversation(agentId, convId)
    const created = await deps.createInstance(agentId, convId)
    /**
     * ⚠ `instanceId` 赋值在 `createInstance` **之后**，而整个创建过程在 `try` **里面**。
     *
     * 两件事都不能省。`createInstance` 把实例注册进 agentRegistry 之后还有若干 await
     * （动态 import 提示词注入器、读记忆注入设置、拼提示词），模型没配好时还会直接抛错。
     * 创建写在 `try` 外面的话，那些点抛错时 `finally { destroy }` **结构上不可达**
     * → 实例永远留在注册表里 → 此后每一拍 `findActivePetAgent()` 都返回它 →
     * 宠物到进程重启前恒为 `skipped: busy`（单飞锁只认"注册表里还有没有"）。
     */
    instanceId = created
    /**
     * 超时兜底。与 `executeSyncConflictGoal` 同一条理由：实例被中止（cascade abort）或
     * 模型端点挂住时 `prompt` / `waitForIdle` 未必 settle，而它们不 settle，`finally`
     * 就不执行 → 实例常驻注册表 → 与上面同一种"宠物永久 busy"。
     */
    await withTimeout(
      (async () => {
        await deps.prompt(created, goal.description)
        await deps.waitForIdle(created)
      })(),
      PET_GOAL_EXEC_TIMEOUT_MS,
      `宠物目标执行超时（${Math.round(PET_GOAL_EXEC_TIMEOUT_MS / 60_000)} 分钟未收尾）`,
    )

    const output = (deps.assistantOutput(created) ?? '').trim()
    const state = deps.instanceState(created)
    /**
     * 失败原因：本轮的 LLM 错误 / 中止。`InstanceState` 里这两个字段**干净收场时会被清空**，
     * 所以"读到了"就等于"这一轮没跑成"（见 `bridge-instance-state.ts` 的注释）。
     */
    const failure =
      state?.lastLlmError?.message?.trim() || (state?.lastAborted ? '这一轮被中断了' : '')
    /**
     * 结论口径（2026-09-24 修，原为 `ok = output.length > 0`）：
     *
     * 1. **没说话 = 没做成**。对宠物这不是苛刻：`PET_PROMPT` 的第一条要求就是
     *    "第一句就是结论"——用户交代这件事，要的就是那句回执。只调了工具不写正文，
     *    对用户而言就是**没有回音**（这条判据保留原来的一半）。
     * 2. **报了错 / 被中断也算没做成**，哪怕它吐了半句话——半句不能让用户以为办妥了。
     *
     * 于是"失败必有原因可说"：`failure` 优先当文案，`PET_GOAL_FAILED_PREFIX`
     * 那条分支因此在链路上真的会走到（此前它恒不可达——失败 ⇔ 正文为空）。
     */
    const ok = output.length > 0 && failure === ''
    const reported = failure || output
    finalizeGoal(deps.db, goal.id, { success: ok, output: reported })
    // 成对落独白：宠物看到的（目标描述）+ 它报回来的。回执写库失败不该影响目标状态
    deps.reportResult(goal, ok, reported, { userTurn: goal.description })
    /**
     * T5.5 的举止反馈：**它替你把事办了会高兴，没办成会蔫**（设计 §7.3）。
     *
     * 走的是宠物自己的事件名，不是 `goal_completed` / `task_failed`——
     * 那两条是"自主进化"这个身份的口味（`goal_completed` 的 arousal 是 **↓**，
     * 即"一件事收尾了、落地"），而宠物办成事的那一下是**兴奋**。
     * 共用会让第四期接在 valence 跨越上的 `Cheer` 几乎永远不够阈值
     * （详见 `mood.ts` 里 `pet_task_done` 的注释）。
     */
    deps.recordMood(ok ? 'pet_task_done' : 'pet_task_failed', agentId)
    /**
     * 七期 T7.3 的「每次真实成败」：**没做成 → 一次 `error-handled`**。
     *
     * 为什么成功那条不发事件：Big Five 上"办成一件事"该往哪挪说不清
     * （更外向？更开放？），而"办砸过一次"有明确方向——更谨慎、更神经质。
     * 塑造这只宠物的应当是**这个人和它的关系**，不是它的绩效；
     * 被回应 / 被冷落那两条由反思汇总后发（`pet-evolve.ts`）。
     *
     * 走到这里就一定真跑过（实例建起来了、有输出或报错），
     * 所以不必再判 `instanceId`——那个判断留给下面 catch 那条路。
     */
    if (!ok) {
      void recordPetPersonalityEvent('error-handled', agentId, {
        goalId: goal.id,
        source: 'pet-task',
      })
    }
    // T5.4 的"真实笨拙"要**真数据**：把这一次的成败记进它自己的能力维度，
    // 下一次受理才判得出"这个我不太拿手"（详见 pet-task-store.ts）
    await recordPetTaskOutcome(
      deps.db,
      agentId,
      readPetTaskDimension(deps.db, goal.id),
      ok,
      goal.description,
    )
    log.info(
      `[executePetGoal] agent=${agentId} goalId=${goal.id} ok=${ok} output=${reported.slice(0, 120) || '（空）'}`,
    )
    return ok ? 'completed' : failure ? 'failed' : 'empty-output'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`[executePetGoal] agent=${agentId} goalId=${goal.id} 执行异常:`, msg)
    // 炸了也要有终态 + 回执：否则目标烂在 executing 里每 5 分钟被重捞一次，
    // 而两道闸门都拦不住它（次数门数的是"跑过几条"，重试不增加；预算门读的是恒为 0 的记账）
    try {
      finalizeGoal(deps.db, goal.id, { success: false, output: msg })
    } catch (finalizeErr) {
      log.error(
        `[executePetGoal] 终态落库失败 goalId=${goal.id}:`,
        finalizeErr instanceof Error ? finalizeErr.message : finalizeErr,
      )
    }
    try {
      deps.reportResult(goal, false, msg)
    } catch (reportErr) {
      log.error(
        `[executePetGoal] 回执发送失败 goalId=${goal.id}:`,
        reportErr instanceof Error ? reportErr.message : reportErr,
      )
    }
    /**
     * 记账与情绪只在这**真跑过**时才做（`instanceId` 非空 = 实例建起来了）。
     *
     * 判据不能少：`createInstance` 就抛错时（模型没配好、提示词拼不起来）
     * 这一轮**一次模型往返都没有**，把它算成"宠物在这类事上不行"是冤枉——
     * 那是我这边的故障，不是它的能力问题。而能力表是**长期**的，
     * 一次错记要在它后面几次受理里一直起作用。
     */
    if (instanceId) {
      deps.recordMood('pet_task_failed', agentId)
      // 七期 T7.3：真跑过（实例建起来了）但炸了 —— 与上面 `!ok` 那条同一个事件，
      // 只是路径不同（抛错 vs 有输出但报错）。**`instanceId` 这一判不能省**：
      // `createInstance` 就抛错时这一轮一次模型往返都没有，那是我的故障不是它的失败
      void recordPetPersonalityEvent('error-handled', agentId, {
        goalId: goal.id,
        source: 'pet-task',
        thrown: true,
      })
      await recordPetTaskOutcome(
        deps.db,
        agentId,
        readPetTaskDimension(deps.db, goal.id),
        false,
        goal.description,
      )
    }
    return `error: ${msg}`
  } finally {
    // 只在真拿到 id 时销毁；创建阶段就抛错的话注册表里本来就没有它
    if (instanceId) deps.destroy(instanceId)
  }
}
