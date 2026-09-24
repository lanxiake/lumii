/**
 * 宠物感知循环（Windows 客户端专用）
 *
 * 对应宠物智能化实施计划第四期。读判断全在 `@mtbot/agent-runtime` 的 `pet-sensing.ts`，
 * 这里只做**副作用**三件：改宠物自己的 mood、推一条气泡事件、记配额。
 *
 * ---------------------------------------------------------------------------
 * 为什么是**另一条** cron，而不是挂在 `pet-dispatch` 上
 * ---------------------------------------------------------------------------
 * 派发循环第一件事就是 `hasActiveUserTurn()` 让路——那条闸门的存在理由是"后台动作
 * 不与用户抢同一个模型端点"。而感知**恰恰要在用户干活的时候看着**：
 * 「你卡住了我过来陪你」「你坐太久了」这两句话，用户在发呆时才说是没有意义的。
 *
 * 挂在派发里，等于让感知继承一条为它而设、却与它相反的闸门。
 * 而且感知是**零 token 零网络**的纯读库（`pet-sensing.ts` 文件头），本就不需要让路——
 * 两件事的门闩不同，就不该共用一条调度。
 *
 * ---------------------------------------------------------------------------
 * 节拍 3 分钟
 * ---------------------------------------------------------------------------
 * 规则①的窗口是 30 分钟、规则②是小时级，看起来都远大于一拍。但"靠近陪着"要的是
 * **当场感**：用户连着打断三次之后的 5 分钟内出现，是"它注意到了"；30 分钟后才出现，
 * 是"它刚才在忙别的"。一拍的成本是一条走索引的 SELECT 加两次主键查询，
 * 所以密一点没有代价。真到了要省电的时候，先看的应该是这条注释而不是把它改成 10 分钟。
 *
 * ---------------------------------------------------------------------------
 * 门闩只有一道：宠物模式
 * ---------------------------------------------------------------------------
 * 与 `companion-tick` 同一条口径——**没有宠物窗就没有气泡，也没有人看 mood**。
 * 刻意**不**跟随 `proactiveCareEnabled`（"主动联系"那个开关）：它的默认值是 `false`，
 * 跟了就等于整个第四期默认不可见。也不跟随自主进化总开关（宠物是独立 Agent，设计 §3.7）。
 *
 * 冒不冒泡由**渲染层**再判一道：`PetOrchestrator.pushNoticeEvent` 在
 * `enableAgentNotice` 关掉时直接返回（那个开关默认是开的）。
 * 两道门闩的分工是「要不要算」与「要不要显示」，与三期 T3.5 的气泡完全一致。
 * 第五期 T5.9 会有宠物自己的「是否允许宠物主动做事」，那时再接管这道门闩。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import {
  collectPetSensingSignals,
  decidePetSensing,
  recordSpoken,
  writeHandledScoreId,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

const PET_SENSING_CRON_ID = 'pet-sensing'
const PET_SENSING_NAME = '桌宠感知'
/** companion 魔法指令（`local-companion-handler.ts` 的 COMPANION_INSTRUCTIONS） */
export const PET_SENSING_INSTRUCTION = '__pet_sensing__'
const PET_SENSING_INTERVAL_MS = 3 * 60_000

/** 推给宠物窗的一条感知事件（形状与 `shared/agent-runtime-events.ts` 的 `PetSensingEvent` 一致） */
export interface PetSensingPush {
  readonly type: 'pet:sensing'
  readonly sessionKey: string
  readonly text: string
  readonly kind: string
}

/** 感知循环依赖的副作用（由 bridge 装配时注入） */
export interface PetSensingDeps {
  getDb: () => DatabaseAdapter
  /** 退出清场中——此时每次读库都必抛，最先判 */
  isShuttingDown?: () => boolean
  /**
   * 当前宠物的 agentId（`pet:<模型ID>`）；不在宠物模式 / 没选模型时返回 `null`。
   *
   * 它同时是**读 mood 的键**与**写 mood 的键**，所以拿不到就整轮不做——
   * 拿错一个身份会让宠物的情绪写到助手头上，那正是设计 §3.7 要隔离的东西。
   */
  getPetAgentId: () => string | null
  /** 记一次宠物自己的情绪事件（落库 + 推表情，见 bridge 的 `recordMoodEvent`） */
  recordMood: (agentId: string, event: string) => void
  /** 推一条感知事件（气泡走 `pet-notice-adapter`） */
  pushSensingEvent: (event: PetSensingPush) => void
  /** 当前时间（可注入，供测试固定） */
  now?: () => Date
  /** 「立即执行」：绕过宠物模式门闩，便于在主窗口自测（与 `companion-tick` 同一约定） */
  manual?: boolean
}

/**
 * 跑一轮宠物感知。
 *
 * 全程 try-catch，异常只记日志并返回可读串，绝不抛给 cron 调度层
 * （与 `runPetDispatch` 同一条约定：返回值写进 `local_cron_runs.summary`）。
 *
 * **一拍最多说一句、最多改一次 mood**：两条规则都过配额，且 mood 只在
 * "第一次看到那条低分"时改一次（`handledScoreId` 幂等），否则每一拍都会再低落一点。
 */
export function runPetSensing(deps: PetSensingDeps): string {
  if (deps.isShuttingDown?.()) return 'skipped: shutting down'
  try {
    const agentId = deps.getPetAgentId()
    if (!agentId) return deps.manual ? 'skipped: no-pet-agent' : 'skipped: not in pet mode'

    const now = deps.now?.() ?? new Date()
    const signals = collectPetSensingSignals(deps.getDb(), agentId, now)
    const decision = decidePetSensing(signals)

    if (decision.moodEvent) {
      deps.recordMood(agentId, decision.moodEvent.event)
      writeHandledScoreId(deps.getDb(), decision.moodEvent.scoreId)
      log.info(
        `[runPetSensing] 宠物情绪 agent=${agentId} event=${decision.moodEvent.event} ` +
          `scoreId=${decision.moodEvent.scoreId}`,
      )
    }

    if (decision.speak) {
      const { kind, text, sessionKey } = decision.speak
      deps.pushSensingEvent({ type: 'pet:sensing', sessionKey, text, kind })
      recordSpoken(deps.getDb(), kind, now)
      log.info(`[runPetSensing] 说了一句 kind=${kind} session=${sessionKey} text="${text}"`)
      return `spoke: ${kind}`
    }

    // 没说话也要留痕：阈值的量法就是连着几天读这行日志（见 pet-sensing.ts 的 noSpeakReason）
    log.info(`[runPetSensing] ${decision.reason}`)
    return `idle: ${decision.reason}`
  } catch (err) {
    log.error('[runPetSensing] 失败:', err)
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * 播种宠物感知 cron job（幂等）。
 *
 * 与 `ensurePetDispatchCronJobSeeded` 同一形态，同样是**形态自愈但不覆盖用户改过的 enabled**；
 * 同样必须 `agent_id = NULL`——非空的话 cron 会把 `__pet_sensing__` 当真实 prompt 喂给某个 Agent。
 */
export function ensurePetSensingCronJobSeeded(db: DatabaseAdapter): void {
  try {
    const existing = db
      .prepare<{ id: string }>(`SELECT id FROM local_cron_jobs WHERE id = ?`)
      .get(PET_SENSING_CRON_ID)

    if (existing) {
      db.prepare(
        `UPDATE local_cron_jobs SET interval_ms = ?, agent_id = NULL,
         schedule_type = 'every', schedule_expr = '',
         active_hour_start = NULL, active_hour_end = NULL, notify_targets = NULL
         WHERE id = ?`,
      ).run(PET_SENSING_INTERVAL_MS, PET_SENSING_CRON_ID)
      return
    }

    const now = Date.now()
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at)
       VALUES (?, ?, ?, NULL, 'every', '', ?, ?, 1, ?)`,
    ).run(PET_SENSING_CRON_ID, PET_SENSING_NAME, PET_SENSING_INSTRUCTION, now, PET_SENSING_INTERVAL_MS, now)
    log.info(`[ensurePetSensingCronJobSeeded] 新建 job id=${PET_SENSING_CRON_ID} intervalMs=${PET_SENSING_INTERVAL_MS}`)
  } catch (err) {
    log.error('[ensurePetSensingCronJobSeeded] 失败:', err)
  }
}
