/**
 * 宠物自主闭环的第三条 cron：反思 + 排期 + 日记（第七期 T7.2 / T7.4 / T7.5）
 *
 * ---------------------------------------------------------------------------
 * 为什么是新的第三条，而不是挂到已有两条上
 * ---------------------------------------------------------------------------
 * 设计 §12.4 的判据是**门闩**而不是节拍：
 *
 * | 链 | 门闩 | 为什么 |
 * |---|---|---|
 * | `pet-sensing`（3 min） | 只在宠物模式 | 它要在用户干活时看着 |
 * | `pet-dispatch`（5 min） | 让路于用户回合 | 不与用户抢模型端点 |
 * | **`pet-evolve`（1 小时）** | **让路于用户回合**（同派发） | 反思不急于当下，且要花 token |
 *
 * 与派发**门闩相同、节拍差 12 倍**——把低频的反思塞进 5 分钟一拍里，
 * 会让"今天反思过没"的守卫混进一条为"点一下 <200ms 有响应"而设的高频循环。
 *
 * ⚠ **不新增第四条**，也不把宠物塞进 `listAutonomousAgentIds()`（T3.1 那张表：
 * 心跳的 `computeReflectionDue` 没有 agent 守卫、`decideAction` 的第一优先级是
 * `proactive-message`——两条都会让宠物的行为变成助手的行为）。
 *
 * ---------------------------------------------------------------------------
 * 一天实际只干 1–2 次活
 * ---------------------------------------------------------------------------
 * 1 小时一拍 × 日界守卫（`pet.evolve.last:<agentId>` 存日期，与日记防重同一手法）。
 * 真正的产出是三件：
 *
 * 1. **反思**（T7.2）：读"我们之间发生了什么" → 一段"我对你的了解" + 一个判读 + 几条建议
 * 2. **排期**（T7.4）：建议落成它自己的目标，交给 `pet-dispatch` 走**同一条**执行链
 * 3. **日记**（T7.5）：复用 bridge 那条既有通路（含双写），只是对象换成宠物
 *
 * ---------------------------------------------------------------------------
 * 四条纪律，一条都不放宽
 * ---------------------------------------------------------------------------
 * 1. **冷启动不硬说**：做过的事不足 3 件 → 不反思。**且不标记"今天做过了"**——
 *    一天里它可能上午只做过两件、下午够了三件，标了就再没机会。
 * 2. **让路于用户回合**：与派发同一条闸门（门闩相同正是"可以共用判据"的理由）。
 * 3. **硬闸门不放宽**：自己排的目标进的是**同一条管道**——同一个单飞锁、
 *    同一个 `MAX_PET_GOALS_PER_DAY`、同一个 `MAX_PET_TOKENS_PER_DAY`（都由派发侧把关）。
 *    这里另加一道：**剩余额度不足就不排**，免得排出来的当场被拒、还占着单飞锁。
 * 4. **不表演**：情绪走真实的 mood 通道（`applyMoodImpact` 那条已有链），
 *    日记与反思里不许写"我好开心呀"（提示词各自带禁令）。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import {
  MAX_PET_GOALS_PER_DAY,
  MIN_EXPERIENCES_FOR_REFLECTION,
  buildPetTaskMetadata,
  countPetRunsToday,
  hasWrittenDiaryToday,
  markDiaryWritten,
  readMood,
  readPetExperience,
  readPetUnderstanding,
  readPetWorkRecords,
  reflectOnPet,
  summarizePetExperience,
  todayDateKey,
  writePetUnderstanding,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'
import { seedCompanionCronJob, setCompanionCronJobEnabled } from './companion-cron-seed'

const PET_EVOLVE_CRON_ID = 'pet-evolve'
const PET_EVOLVE_NAME = '桌宠反思'
/** companion 魔法指令（`local-companion-handler.ts` 的 COMPANION_INSTRUCTIONS） */
export const PET_EVOLVE_INSTRUCTION = '__pet_evolve__'

/**
 * 节拍：1 小时。
 *
 * 比派发（5 分钟）与感知（3 分钟）都疏得多，因为它做的是**日频**的事：
 * 反思、排期、日记。一小时一拍只是为了让"到点了"这件事在开机后一小时内被发现——
 * 真正的开关是日界守卫与写日记的时间窗。
 */
const PET_EVOLVE_INTERVAL_MS = 60 * 60_000

/**
 * 日记最早几点写（本地时间）。
 *
 * 与助手的静默时段触发（23:00）不同：宠物日记写的是"今天和这个人之间"，
 * 而用户 20 点之后大概率还在电脑前——那时写，它当天还能被看见。
 * 太早写则今天后半天发生的事全都不在里面。
 */
const DIARY_EARLIEST_HOUR = 20

/** 反思 + 排期的日界键（**按宠物分**：两只宠物各有一天的账） */
const LAST_EVOLVE_KEY_PREFIX = 'pet.evolve.last:'

function lastEvolveKey(agentId: string): string {
  return `${LAST_EVOLVE_KEY_PREFIX}${agentId}`
}

/** 今天是否已经反思过（读失败按"没有"处理：宁可多反思一次，也不要永远不反思） */
function hasEvolvedToday(db: DatabaseAdapter, agentId: string, now: Date): boolean {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(lastEvolveKey(agentId))
    return row?.value === todayDateKey(now)
  } catch {
    return false
  }
}

function markEvolvedToday(db: DatabaseAdapter, agentId: string, now: Date): void {
  try {
    db.prepare(
      `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(lastEvolveKey(agentId), todayDateKey(now), new Date().toISOString())
  } catch {
    /* 标记失败只是下次可能重复反思一次 */
  }
}

/** 人格事件种类（与 `EVENT_PERSONALITY_IMPACT` 里那三条同名） */
export type PetPersonalityEventType =
  | 'error-handled'
  | 'user-feedback-positive'
  | 'user-feedback-negative'

/** 反思 + 排期 + 日记依赖的副作用（由 bridge 装配时注入） */
export interface PetEvolveDeps {
  getDb: () => DatabaseAdapter
  /** 退出清场中——此时每次读库都必抛，最先判 */
  isShuttingDown?: () => boolean
  /** 真实用户回合进行中 → 让路（与派发**同一条**判据，见文件头） */
  hasActiveUserTurn?: () => boolean
  /** 当前宠物的 agentId（`pet:<模型ID>`）；不在宠物模式 / 没选模型时 `null` */
  getPetAgentId: () => string | null
  /** 反思用的 LLM（经桥接的独立管道）。缺省 → 整条反思链不做，日记照旧 */
  callLLM?: (prompt: string) => Promise<string>
  /** 写一篇日记（复用 bridge 的既有通路：宠物会话 + `autonomous_diaries` 双写） */
  writeDiary?: (agentId: string) => Promise<string>
  /** 记一次人格事件（演进，T7.3） */
  recordPersonality?: (
    eventType: PetPersonalityEventType,
    agentId: string,
    context: Record<string, unknown>,
  ) => Promise<void>
  /** 把"我对你的了解"写进宠物**自己的记忆**（与 `runtime_state` 那份是两个用途） */
  rememberUnderstanding?: (agentId: string, text: string) => void
  /**
   * 「允许宠物主动做事」总开关（五期 T5.9）。缺省视为开。
   *
   * **反思 / 排期 / 日记三件都跟它**（2026-09-24 定）：那个开关的用户语义就是
   * "它自己动不动"，而这三件都是它自己在动——反思要花 token、排期会产生活、
   * 日记也得调一次模型。挑其中一件不跟，用户会看到"我明明关了它还在写日记"。
   *
   * 与 job 的 `enabled`（{@link syncPetEvolveJobEnabled}）**两道都要有**，
   * 理由见 `companion-cron-seed.ts` 的 `setCompanionCronJobEnabled`。
   */
  isPetTaskEnabled?: () => boolean
  /** 当前时间（可注入，供测试固定排期） */
  now?: () => Date
  /**
   * 「立即执行」：绕过**日界守卫**（供自测与任务页手动触发）。
   *
   * 刻意**不绕**冷启动守卫与让路闸门：那两道不是"节流"，是"该不该做"。
   * 手动点一下不该让一只刚出生的宠物凭空说"我了解你"。
   */
  manual?: boolean
}

/**
 * 跑一轮宠物反思 + 排期 + 日记。
 *
 * 全程 try-catch，异常只记日志并返回可读串，绝不抛给 cron 调度层
 * （与 `runPetDispatch` / `runPetSensing` 同一条约定：返回值写进 `local_cron_runs.summary`）。
 */
export async function runPetEvolve(deps: PetEvolveDeps): Promise<string> {
  if (deps.isShuttingDown?.()) return 'skipped: shutting down'
  try {
    return await runPetEvolveInner(deps)
  } catch (err) {
    log.error('[runPetEvolve] 失败:', err)
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function runPetEvolveInner(deps: PetEvolveDeps): Promise<string> {
  // 总开关判在最前面（与派发同一道，见 `isPetTaskEnabled` 的注释）
  if (deps.isPetTaskEnabled && !deps.isPetTaskEnabled()) return 'skipped: pet task disabled'
  if (deps.hasActiveUserTurn?.()) return 'skipped: user turn in progress'
  const agentId = deps.getPetAgentId()
  if (!agentId) return 'skipped: no-pet-agent'

  const db = deps.getDb()
  const now = deps.now?.() ?? new Date()
  const parts: string[] = []

  // ── 反思 + 排期（一天一次）───────────────────────────────────────────
  if (!deps.manual && hasEvolvedToday(db, agentId, now)) {
    parts.push('reflect: already-today')
  } else {
    const reflected = await reflectAndSchedule(deps, db, agentId, now)
    parts.push(reflected)
    /**
     * **冷启动不标记**（见文件头纪律 1）：它今天还没反思过，只是料不够。
     * 标了的话，这一整天剩下的十几个小时里它都不会再试——而"做过三件事"
     * 完全可能发生在下午。
     */
    if (!reflected.startsWith('cold-start')) markEvolvedToday(db, agentId, now)
  }

  // ── 日记（一天一次，晚上）───────────────────────────────────────────
  parts.push(await maybeWriteDiary(deps, db, agentId, now))

  return parts.join('; ')
}

/**
 * 反思 → 落三样产出。
 *
 * 三样各自独立兜错：写下"了解"失败不该让排期不发生，反之亦然
 * （它们共用的是**同一次 LLM 调用**，那笔钱已经花掉了）。
 */
async function reflectAndSchedule(
  deps: PetEvolveDeps,
  db: DatabaseAdapter,
  agentId: string,
  now: Date,
): Promise<string> {
  // 取成局部：下面那个 `complete` 闭包里 TS 不会保留 `deps.callLLM` 的收窄，
  // 用 `!` 断言的话，将来有人挪动上面那行判断就会变成一个静默的运行时错误
  const callLLM = deps.callLLM
  if (!callLLM) return 'reflect: no-llm'

  const works = readPetWorkRecords(db, agentId)
  const reaction = summarizePetExperience(readPetExperience(db, agentId), now)
  const output = await reflectOnPet(
    {
      agentId,
      experiences: works,
      reaction,
      mood: readMood(db, agentId),
      previousUnderstanding: readPetUnderstanding(db, agentId),
    },
    { complete: async ({ prompt }) => ({ content: await callLLM(prompt) }) },
  )

  if (output.coldStart) {
    return `cold-start: works=${works.length} (<${MIN_EXPERIENCES_FOR_REFLECTION})`
  }

  // ① "我对你的了解" → 宠物自己的记忆 + 一份给下次反思做上下文的副本
  if (output.understanding) {
    writePetUnderstanding(db, agentId, output.understanding)
    try {
      deps.rememberUnderstanding?.(agentId, output.understanding)
    } catch (err) {
      log.warn('[runPetEvolve] 写入记忆失败:', err instanceof Error ? err.message : err)
    }
  }

  // ② 判读 → 人格事件（演进，T7.3）
  if (output.feedback && deps.recordPersonality) {
    const eventType: PetPersonalityEventType =
      output.feedback === 'positive' ? 'user-feedback-positive' : 'user-feedback-negative'
    try {
      await deps.recordPersonality(eventType, agentId, {
        source: 'pet-reflection',
        positive: reaction.positive,
        ignored: reaction.ignored,
      })
    } catch (err) {
      log.warn('[runPetEvolve] 记人格事件失败:', err instanceof Error ? err.message : err)
    }
  }

  // ③ 建议 → 它自己的目标（走同一条执行链）
  const landed = landSelfGoals(db, agentId, output.suggestions, now)

  log.info(
    `[runPetEvolve] agent=${agentId} understanding=${output.understanding ? 'yes' : 'no'} ` +
      `feedback=${output.feedback ?? 'null'} landed=${landed}`,
  )
  return `reflect: ${output.suggestions.length} suggested, ${landed} landed`
}

/**
 * 把反思的建议落成宠物自己的目标。
 *
 * **与用户交代的目标进的是同一张表、同一条执行链**（`pet-dispatch` 捞的是
 * `status='executing'` 的全体宠物目标）。区别只有两处，都在 `metadata` 里：
 * `origin: 'self'`，以及 `dimension: null`（自己排的不做能力边界判断——
 * 那件事的难度不是它自己说了算的）。
 *
 * @returns 真正落库的条数
 */
function landSelfGoals(
  db: DatabaseAdapter,
  agentId: string,
  suggestions: ReadonlyArray<{ description: string; reason: string }>,
  now: Date,
): number {
  if (suggestions.length === 0) return 0

  /**
   * 剩余额度不足就不排。
   *
   * 排了也跑不成：派发的闸门会当场拒绝并把目标落成 `failed`——
   * 那条"失败"会进它的经历，而它其实什么都没做错（是额度用完了）。
   * 与其这样，不如这次不排，明天再说。
   *
   * 留一条余量给用户：自己找事做**不该把用户当天的额度吃光**。
   */
  const runsToday = countPetRunsToday(db, agentId, now)
  const remaining = MAX_PET_GOALS_PER_DAY - runsToday
  if (remaining <= 1) {
    log.info(`[runPetEvolve] 今日额度不足，本次不排期 runsToday=${runsToday}`)
    return 0
  }

  try {
    // 去重：同描述的未完成目标不再排（与 `landSuggestedGoals` 同一手法）
    const existing = db
      .prepare<{ description: string }>(
        `SELECT description FROM autonomous_goals
          WHERE agent_id = ? AND status IN ('pending', 'approved', 'executing')`,
      )
      .all(agentId)
    const seen = new Set(existing.map((r) => r.description))

    const insert = db.prepare(
      `INSERT INTO autonomous_goals
       (id, agent_id, type, description, trigger_reason, status, priority, metadata,
        scheduled_for, planned_by, created_at)
       VALUES (?, ?, 'learning', ?, 'self-scheduled', 'executing', 1, ?, NULL, 'pet', ?)`,
    )
    let landed = 0
    for (const s of suggestions.slice(0, Math.min(2, remaining - 1))) {
      const desc = s.description.trim()
      if (!desc || seen.has(desc)) continue
      seen.add(desc)
      insert.run(
        `pet-self-${crypto.randomUUID()}`,
        agentId,
        desc,
        buildPetTaskMetadata(null, 'self'),
        now.toISOString(),
      )
      landed++
    }
    return landed
  } catch (err) {
    log.warn('[runPetEvolve] 排期落库失败:', err instanceof Error ? err.message : err)
    return 0
  }
}

/**
 * 日记：一天一篇，且**过了 20 点才写**（理由见 `DIARY_EARLIEST_HOUR`）。
 *
 * ⚠ **判据与标记都在这里**（2026-09-24 修）。
 *
 * 原先只在 `bridge.writeDiaryFor` 里 `markDiaryWritten`，这一处只判不记——
 * 于是"一天一篇"这个保证挂在**被注入的实现**身上：注入一个忘了标记的实现
 * （测试替身、将来某个新宿主），守卫就永远读到"今天没写过"，
 * 一晚上写十篇，而两处都不报错。
 * 判据与落点分开是最典型的静默失效形态，收在一处才是稳的
 * （重复标记是幂等的：同一个键、同一个值）。
 */
async function maybeWriteDiary(
  deps: PetEvolveDeps,
  db: DatabaseAdapter,
  agentId: string,
  now: Date,
): Promise<string> {
  if (!deps.writeDiary) return 'diary: no-writer'
  if (now.getHours() < DIARY_EARLIEST_HOUR) return 'diary: too-early'
  if (hasWrittenDiaryToday(db, agentId, now)) return 'diary: already-today'
  try {
    const head = await deps.writeDiary(agentId)
    markDiaryWritten(db, agentId, now)
    return `diary: ${head}`
  } catch (err) {
    // 日记失败不影响反思那两样（它们已经落库了）。
    // 也**不标记**：没写成就不该算写过，下一拍还有机会。
    log.warn('[runPetEvolve] 写日记失败:', err instanceof Error ? err.message : err)
    return 'diary: failed'
  }
}

/**
 * 播种宠物反思 cron job（幂等）。
 *
 * 与 `pet-dispatch` / `pet-sensing` **共用** `seedCompanionCronJob`：形态一旦漂移
 * （`agent_id` 非空），cron 会把 `__pet_evolve__` 当真实 prompt 喂给某个 Agent
 * ——用户会看到模型在认真回答一句 `__pet_evolve__`。
 *
 * `enabledOnCreate: 1` 且**不覆盖**用户改过的 `enabled`（同 `pet-dispatch`）。
 */
export function ensurePetEvolveCronJobSeeded(db: DatabaseAdapter): void {
  seedCompanionCronJob(db, {
    id: PET_EVOLVE_CRON_ID,
    name: PET_EVOLVE_NAME,
    instruction: PET_EVOLVE_INSTRUCTION,
    intervalMs: PET_EVOLVE_INTERVAL_MS,
    enabledOnCreate: 1,
  })
}

/**
 * 「允许宠物主动做事」总开关 → 这条 job 的 `enabled`（七期 T7.4）。
 *
 * 与 {@link runPetEvolve} 入口那道判据**两道都要有**，理由见
 * `companion-cron-seed.ts` 的 `setCompanionCronJobEnabled`；
 * 启动时也要同步一次（否则会出现"设置里关着、任务页里开着"）。
 */
export function syncPetEvolveJobEnabled(db: DatabaseAdapter, enabled: boolean): void {
  setCompanionCronJobEnabled(db, PET_EVOLVE_CRON_ID, enabled)
}
