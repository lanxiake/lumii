/**
 * 「让它去做」：受理 → 落库 → 立刻派发 → 回执持久化（五期 T5.1 / T5.7 / T5.8）
 *
 * 设计 §4.2「能上场」与 §10.3.3「派活交互」。判据（接不接、怎么说）全在
 * `@mtbot/agent-runtime` 的 `pet-task.ts` 里，是纯的；**这里只做副作用**：
 * 读写库、推事件、把宠物流那一列喂给控制坞。与四期 `pet-sensing.ts` /
 * `pet-sensing-tick.ts` 是同一个切法。
 *
 * ---------------------------------------------------------------------------
 * 与 `pet-dispatch.ts` 的分工
 * ---------------------------------------------------------------------------
 * 本模块负责**入口**（用户点一下 → 目标落库 → 踢一脚派发），
 * `pet-dispatch.ts` 负责**出口**（找活、让路、执行）。两者都写同一张表，
 * 但一个在"用户刚说完话"的那一刻同步跑，另一个在 cron 节拍上跑。
 *
 * ⚠ **推的那一脚不是替代 cron**：`runPetDispatch` 里有"用户回合进行中 → 让路"
 * 的判断（设计 §4.2.3 的纪律），所以用户一边打字一边派活时，那一脚会被跳过，
 * 目标留在 `executing` 等下一拍（≤5 分钟）。这是**想要的**：宠物不跟用户抢。
 *
 * ---------------------------------------------------------------------------
 * 为什么回执落 `autonomous_goals.metadata` 而不是新开一张表
 * ---------------------------------------------------------------------------
 * 设计 §4.2.2 的硬要求：「气泡是瞬时的，用户去倒杯水就错过回执」——所以回执必须
 * 有个**持久**的家。三个候选：
 *
 * | 方案 | 为什么不用 |
 * |---|---|
 * | 宠物会话的消息 | 原文确实在那里（`finishPetGoal` 写的），但**没有 `ok`**，也没有目标 id，控制坞分不出"成没成"，更做不了未读（那是"这一条我读过没"，跟消息本身无关） |
 * | `runtime_state` 前缀扫 | 键值表没有顺序保证，得全表扫 + 自己解析，还要额外做剪枝 |
 * | **`metadata` 那一列** | 已有列、自由 JSON、已被三种写法占用（`reflection-suggestion` / `planner` / `lowestDimension`），天然就是"这条目标的出处与载荷" |
 *
 * 顺带把**受理时判出的能力维度**也存进去（`PetTaskMetadata.dimension`）：
 * 收尾时才知道该给哪个维度记一次成败，而收尾那一刻手上只有目标行。
 */

import {
  MAX_PET_GOALS_PER_DAY,
  MAX_PET_TOKENS_PER_DAY,
  TOKEN_COST,
  buildPetTaskMetadata,
  canSpendTokens,
  classifyPetRequest,
  countPetRunsToday,
  decidePetTask,
  petTaskQuotaReason,
  readTodayTokenUsage,
} from '@mtbot/agent-runtime'
import { petAgentId } from '@mtbot/pet-core'
import { getAgentRuntimeBridge } from '../ipc/agent-runtime-ipc'
import { isPetMode } from '../pet/pet-mode-ipc'
import { getStoredModelId, getVirtualHumanSettings } from '../pet/pet-mode-store'
import type { PetTaskCreateResult, PetTaskStateDTO } from '../../shared/pet-mode'
import { agentRuntimeLog as log } from './bridge-utils'
import {
  hasRunningPetTask,
  readPetTaskBoundary,
  readPetTaskState,
  writePetTaskReadCursor,
} from './pet-task-store'

/** bridge 没起 / 不在宠物模式 → 现在没有"这只宠物" */
function currentPetAgentId(): string | null {
  if (!isPetMode()) return null
  const configId = getStoredModelId()
  return configId ? petAgentId(configId) : null
}

/** 现在没有可用的宠物会话时的统一说法 */
const NOT_READY_REASON = '我还没准备好，等一下再试？'

/**
 * 受理并派出一件事。
 *
 * 判断顺序（**每一步都早退**，越早越省）：
 * 1. 空文本 / 总开关 —— 一次设置读取，最便宜
 * 2. 能力边界 —— 唯一一次**异步**读（`CapabilityTracker`），要去查 `capability_dimensions`
 * 3. 单飞锁 / 日闸门 / 预算 —— **同步**，且必须紧贴 INSERT（理由见下面那段 ⚠）
 *
 * ⚠ 闸门在这里判一遍、派发侧还会再判一遍。**不是重复**：这里判是为了给用户
 * **立刻**一个诚实的回答（"今天已经使唤我 5 次了"），派发侧那道是安全网
 * （两处都调 `countPetRunsToday` / `canSpendTokens`，口径不会漂）。
 */
export async function createPetTask(text: string): Promise<PetTaskCreateResult> {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: '想说让我去看什么？' }

  const bridge = getAgentRuntimeBridge()
  const agentId = currentPetAgentId()
  if (!bridge || !agentId) return { ok: false, reason: NOT_READY_REASON }

  const db = bridge.db
  const now = new Date()

  try {
    /**
     * 「允许宠物主动做事」总开关（五期 T5.9）。判在最前面：关掉了还让用户填一句话、
     * 点一下、等一会儿再告诉他"不行"，是在浪费他的时间。
     *
     * 与派发侧 `runPetDispatch` 里那道是**同一个设置的两个落点**，
     * 但两处都要有：那个是心跳的兜底（用户可能在设置页之外改了它），
     * 这里管的是"别受理"——已受理的目标会一直挂在 `executing` 里等开关打开。
     */
    if (!getVirtualHumanSettings().enablePetTask) {
      return { ok: false, reason: '我现在不主动做事（设置里关着呢），要用的话先去打开。' }
    }

    // 先分类再读边界：判不出维度就不读表（也就不会因为一个错的维度去拒人）
    const boundary = await readPetTaskBoundary(db, agentId, classifyOnly(trimmed))
    const decision = decidePetTask(trimmed, boundary)
    if (!decision.accept) {
      log.info(`[createPetTask] 拒绝 agent=${agentId} text="${trimmed.slice(0, 40)}" 理由=${decision.reason}`)
      return { ok: false, reason: decision.reason }
    }

    /**
     * ⚠ **三道同步判断必须挤在 INSERT 之前，中间不许再 await。**
     *
     * 下面这三段（单飞锁 / 日闸门 / 预算）原本在 `readPetTaskBoundary` **之前**，
     * 而那句是 `await`——于是"读库 → 插入"之间有一个异步窗口：
     * 两次几乎同时到达的受理会**双双通过单飞锁**，各插一行，宠物同时跑两件事。
     * 用户手点三下不太容易撞上（间隔上百毫秒，而窗口只有读一次库的时间），
     * 但"不容易撞上"不是"不会撞上"，而这条链路的全部意义就是**不会跑飞**
     * （设计 §4.2.3）。挪到这里之后，判完到写库之间是纯同步的，
     * 单线程运行时里等价于原子。
     *
     * 代价：被判"不拿手"的那次白读了一次能力表（一条主键查询）。
     * 拿这个换掉一个真实存在的竞态，值。
     *
     * 单飞锁本身（设计 §4.2.3）：一次一件。判据是"库里还有没有 `executing` 的宠物任务"，
     * 而**不是**"实例在不在跑"——目标已经落库但还没轮到派发时，同样算"在手头"，
     * 否则用户连点两下会排进两件。
     */
    if (hasRunningPetTask(db, agentId)) {
      return { ok: false, reason: '我先把手头这件看完，等我说完。' }
    }

    // 两道硬闸门：与派发侧**同一对函数**，只是提前问一次（早退比 late failure 好解释）
    const runsToday = countPetRunsToday(db, agentId, now)
    if (runsToday >= MAX_PET_GOALS_PER_DAY) {
      return { ok: false, reason: petTaskQuotaReason(runsToday, MAX_PET_GOALS_PER_DAY) }
    }
    if (!canSpendTokens(db, agentId, now, TOKEN_COST.executeGoal, MAX_PET_TOKENS_PER_DAY)) {
      const used = readTodayTokenUsage(db, agentId, now)
      return {
        ok: false,
        reason: `今天我跑不动了（预算已用 ${used}／${MAX_PET_TOKENS_PER_DAY}），明天再派？`,
      }
    }

    const id = `pet-task-${crypto.randomUUID()}`
    const createdAt = now.toISOString()
    db.prepare(
      `INSERT INTO autonomous_goals
         (id, agent_id, type, description, trigger_reason, status, priority, metadata, created_at, planned_by)
       VALUES (?, ?, ?, ?, ?, 'executing', ?, ?, ?, 'pet')`,
    ).run(
      id,
      agentId,
      // ⚠ type 用的是既有六个枚举值里**最不坏**的一个：用户交代的是"去看一眼、弄清楚"，
      // 而枚举里没有为它准备的值（learning / proactive-message / capability-improvement /
      // skill-enhancement / memory-optimization / system-maintenance）。
      // 宠物这条线**刻意不引入新类型**：`type` 列带 CHECK 约束，加一个值要重建整张表
      // （见 schema.ts 的 v40 那种搬迁），而宠物侧没有任何一处按 type 分支
      //（`buildGoalPrompt` 与心跳派发都不吃宠物目标，见 pet-definition.ts 文件头）。
      // **真正的出处标记是 `metadata.source`**，它才是判据。
      'learning',
      trimmed,
      '用户交代',
      1,
      buildPetTaskMetadata(decision.dimension),
      createdAt,
    )
    log.info(`[createPetTask] 受理 agent=${agentId} id=${id} dimension=${decision.dimension ?? '(判不出)'}`)

    // 立刻踢一脚派发：cron 节拍是 5 分钟，用户刚点完等 5 分钟才动是不像话的。
    // **不 await**：那一轮可能跑一分钟，不该让 IPC 挂那么久（前端要的是 <200ms 的响应）。
    void bridge.dispatchPetGoalsNow().catch((err: unknown) => {
      log.warn(`[createPetTask] 立即派发失败（留给下一拍 cron）: ${err instanceof Error ? err.message : err}`)
    })

    return { ok: true, id }
  } catch (err) {
    log.error('[createPetTask] 失败:', err)
    return { ok: false, reason: '我这边出了点岔子，等一下再试？' }
  }
}

/**
 * 只做分类、不读边界。
 *
 * `decidePetTask` 内部也会分一次类，但那是**它**的事；这里要先知道维度才能去读表。
 * 之所以分两步而不是把"读边界"塞进纯函数：`pet-task.ts` 是零 IO 的，
 * 而"读哪一行"是宿主的事（见那个文件头）。
 *
 * ⚠ 这里与 `decidePetTask` **各分一次类**，两次必须得到同一个答案。现在它们必然一致
 * ——同一个纯函数、同一个入参。**但别把分类改成有状态的**（加缓存、读配置、按时间变）：
 * 那样"拿来查边界的维度"与"写进 `metadata` 的维度"会分叉，而分叉的表现是
 * **这次成败记到另一个维度上**——不报错，只是宠物的能力表慢慢变得不像它自己。
 */
function classifyOnly(text: string) {
  return classifyPetRequest(text)
}

/**
 * 读控制坞要的那一份状态。bridge 没起 / 不在宠物模式 → `null`（渲染层按"暂时读不到"处理）。
 *
 * 真正的读库在 `pet-task-store.ts`（那边只吃 `db`，所以能直接单测）；这里只负责
 * 把"现在这只宠物是谁"接上——那要 `isPetMode()` 加持久化的模型 ID，是宿主的事。
 */
export function getPetTaskState(): PetTaskStateDTO | null {
  const bridge = getAgentRuntimeBridge()
  const agentId = currentPetAgentId()
  if (!bridge || !agentId) return null
  return readPetTaskState(bridge.db, agentId)
}

/**
 * 把宠物流标记为已读（游标推到"现在"）。
 *
 * 用**一个游标**而不是逐条标记：用户看的是这个列表，不是逐条点开；
 * 且逐条标记要为一次点击写 N 行。见 `petTaskReadCursorKey` 的注释。
 */
export function markPetTaskRead(): void {
  const bridge = getAgentRuntimeBridge()
  const agentId = currentPetAgentId()
  if (!bridge || !agentId) return
  try {
    writePetTaskReadCursor(bridge.db, agentId, new Date().toISOString())
    log.info(`[markPetTaskRead] agent=${agentId}`)
  } catch (err) {
    log.warn(`[markPetTaskRead] 失败: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * 「转给主助手」要送进主会话的那段话。
 *
 * 措辞以**用户的口吻**写：这一轮是用户按的按钮（设计 §4.2.2 的"唯一通道，
 * 且是用户主动触发"），所以它进主会话时应当像用户在说话，而不是像系统插播。
 * 宠物的原话**逐字引用**——改写它就是在替宠物撒谎（§7.1）。
 */
export function buildPetHandoffText(item: { description: string; text: string }): string {
  return `桌宠去看了「${item.description}」，回来报的是：\n${item.text}\n\n你接着处理一下。`
}
