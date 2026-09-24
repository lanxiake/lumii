/**
 * 宠物任务的**落库那一层**：能力边界、回执、能力记账（五期 T5.3 / T5.4 / T5.8）。
 *
 * ---------------------------------------------------------------------------
 * 为什么单独一个文件，而不是塞进 `pet-task-service.ts`
 * ---------------------------------------------------------------------------
 * 这个模块被**两边**调用，而两边的依赖方向相反：
 * - `pet-task-service.ts`（受理时读边界）走 `getAgentRuntimeBridge()` 拿 db；
 * - `bridge.ts`（跑完写回执、记成败）**自己就是**那个 bridge。
 *
 * 后一条是关键：`bridge.ts` 里 import `pet-task-service.ts` 会绕出一个
 * bridge → service → agent-runtime-ipc → bridge 的环。所以这里剥成
 * **只吃 `db` 参数、不碰 bridge** 的一层，谁都能安全引。
 *
 * ---------------------------------------------------------------------------
 * 为什么能力记账用 `CapabilityTracker` 而不是自己写 UPDATE
 * ---------------------------------------------------------------------------
 * Elo 那条公式（`newLevel = level + K/100 × (actual - expected)`）在
 * `capability-rating-system.ts` 里，`assistant` 那 138599 次测试走的就是它。
 * 在宠物这条线上抄一份，等于给同一个数字造两份实现——而两份实现漂移的表现是
 * **宠物的能力值和助手的对不上口径**：不报错，只让"它到底行不行"变成两套答案。
 */

import {
  CapabilityTracker,
  PET_TASK_ASSUMED_DIFFICULTY,
  createExtendedDbClient,
  petTaskReadCursorKey,
  readPetTaskMetadata,
  withPetTaskResult,
  type CapabilityDimension,
  type DatabaseAdapter,
  type PetTaskBoundary,
} from '@mtbot/agent-runtime'
import type { PetTaskItemDTO, PetTaskStateDTO } from '../../shared/pet-mode'
import { toAsyncClient } from './autonomous-wiring'
import { agentRuntimeLog as log } from './bridge-utils'

/**
 * 控制坞宠物流最多列多少条。够翻到刚才那几件，不至于把坞撑长。
 *
 * ⚠ 与**未读数**的关系：未读数是在这 20 条里数的，更早的那些不计入。
 * 这是刻意的——坞里列不出来的一律不给未读标记（标了也没处看）。
 */
const PET_TASK_LIST_LIMIT = 20

/** 一批取出来再筛的数量。SQL 只做 agent_id 前缀，精确过滤在 JS（见 `readPetTaskState`） */
const PET_TASK_SCAN_LIMIT = 60

function trackerFor(db: DatabaseAdapter): CapabilityTracker {
  return new CapabilityTracker(createExtendedDbClient(toAsyncClient(db)))
}

/**
 * 读宠物自己的边界。**没测过返回 `null`**，不返回 `{level: 0.5, testCount: 0}`。
 *
 * `CapabilityTracker.getCapabilityState` 对不存在的行给的是
 * `{ level: 0.5, confidence: 0, testCount: 0 }`——那是 schema 的缺省占位，不是成绩。
 * 直接把它当"中等水平"用，宠物就会凭一个从没测过的 0.5 说"我拿手 / 我不拿手"。
 * 判据取 `testCount`（`confidence` 也行，但样本量更直白）。
 *
 * 读失败按 `null` 算（= 不做能力判断）：这只影响"要不要拒"，而**放行**是安全的那一侧。
 */
export async function readPetTaskBoundary(
  db: DatabaseAdapter,
  agentId: string,
  dimension: CapabilityDimension | null,
): Promise<PetTaskBoundary | null> {
  if (!dimension) return null
  try {
    const state = await trackerFor(db).getCapabilityState(agentId, dimension)
    if (state.testCount <= 0) return null
    return { level: state.level, testCount: state.testCount }
  } catch {
    return null
  }
}

/**
 * 记一次真实成败（跑完、跑砸都算一次）。
 *
 * **难度取 {@link PET_TASK_ASSUMED_DIFFICULTY}（0.5 = 不知道）**，理由见那个常量的注释：
 * 真实难度要标注，而标注本身就得靠猜。取中点的净效果是 `level` 收敛到
 * **它在这类事上的成功率**——那正好是"我拿不拿手"要问的问题。
 *
 * 不抛错：记账失败不该把一次已经跑完的目标炸成失败（回执已经发出去了）。
 * 与 `recordMoodEvent` 同一条约定——这类"事后记账"永远只是旁路。
 */
export async function recordPetTaskOutcome(
  db: DatabaseAdapter,
  agentId: string,
  dimension: CapabilityDimension | null,
  ok: boolean,
  summary: string,
): Promise<void> {
  if (!dimension) return
  try {
    await trackerFor(db).recordTest({
      agentId,
      dimension,
      sessionId: 'pet-task',
      taskSummary: summary.slice(0, 200),
      difficulty: PET_TASK_ASSUMED_DIFFICULTY,
      result: ok ? 'success' : 'failure',
    })
  } catch (err) {
    log.warn(`[recordPetTaskOutcome] 记账失败 agent=${agentId} dim=${dimension}:`, err instanceof Error ? err.message : err)
  }
}

/** 受理时存下的维度（收尾记账要用它）。非宠物任务 / 读不到 → `null` */
export function readPetTaskDimension(db: DatabaseAdapter, goalId: string): CapabilityDimension | null {
  try {
    const row = db
      .prepare<{ metadata: string | null }>(`SELECT metadata FROM autonomous_goals WHERE id = ?`)
      .get(goalId)
    return readPetTaskMetadata(row?.metadata)?.dimension ?? null
  } catch {
    return null
  }
}

/**
 * 把回执落进 `autonomous_goals.metadata`（持久，供控制坞的宠物流读）。
 *
 * **只动宠物任务那一行**：`metadata` 是自由 JSON，别的目标行里存着
 * `{"source":"reflection-suggestion"}` / `{"lowestDimension":…}` 这类东西，
 * 给它们套上 `source: 'pet-task'` 会把那些字段一并抹掉，并让它们**从此被当成宠物回执**
 * （`readPetTaskMetadata` 会认）。所以非宠物任务直接返回。
 *
 * 不抛错：回执已经在气泡上了，写库失败只是"回来时列表里少一条"，
 * 不该把一次已经完成的目标炸成失败。
 */
export function persistPetTaskReceipt(
  db: DatabaseAdapter,
  goalId: string,
  ok: boolean,
  text: string,
  at: string,
): void {
  try {
    const row = db
      .prepare<{ metadata: string | null }>(`SELECT metadata FROM autonomous_goals WHERE id = ?`)
      .get(goalId)
    const existing = readPetTaskMetadata(row?.metadata)
    if (!existing) return
    db.prepare(`UPDATE autonomous_goals SET metadata = ? WHERE id = ?`).run(
      withPetTaskResult(row?.metadata, ok, text, at),
      goalId,
    )
  } catch (err) {
    log.warn(`[persistPetTaskReceipt] 落库失败 goalId=${goalId}:`, err instanceof Error ? err.message : err)
  }
}

// ── 控制坞那一区要读的三样（五期 T5.8）──────────────────────────────────

/**
 * 这只宠物现在有没有在手头的事。
 *
 * 判据是"库里还有没有 `executing` 的宠物任务"，**不是**"实例在不在跑"
 * （那个是 `findActivePetAgent`，T3.4 的单飞锁）：
 * 目标已受理但还没轮到派发时，同样该算"在手头"——否则用户连点两下会排进两件。
 *
 * 读不到按"没有"算：这是**限制**，读不到就锁死会让宠物永远动不了。
 */
export function hasRunningPetTask(db: DatabaseAdapter, agentId: string): boolean {
  try {
    const row = db
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM autonomous_goals
          WHERE agent_id = ? AND status = 'executing' AND metadata LIKE '%pet-task%'`,
      )
      .get(agentId)
    return (row?.n ?? 0) > 0
  } catch {
    return false
  }
}

interface PetTaskRow {
  id: string
  description: string
  status: string
  created_at: string
  completed_at: string | null
  metadata: string | null
}

/** 取这只宠物近期的任务行（新的在前）。行数极少先粗取再精筛 */
function listRows(db: DatabaseAdapter, agentId: string): PetTaskRow[] {
  try {
    return db
      .prepare<PetTaskRow>(
        `SELECT id, description, status, created_at, completed_at, metadata
           FROM autonomous_goals
          WHERE agent_id = ? AND metadata LIKE '%pet-task%'
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(agentId, PET_TASK_SCAN_LIMIT)
  } catch (err) {
    log.warn(`[listRows] 读宠物任务失败: ${err instanceof Error ? err.message : err}`)
    return []
  }
}

/**
 * 读未读游标（毫秒）。没写过返回 0 —— **首次进来时历史回执全部算未读**。
 *
 * 这是刻意的：那个场景正是设计 §4.2.2 要保的（"用户交代了事，回来必须看得到"）。
 * 若默认成"now"，第一次打开坞会把之前所有没看过的回执一并标成已读——恰好把要保的丢了。
 */
export function readPetTaskReadCursor(db: DatabaseAdapter, agentId: string): number {
  try {
    const raw = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(petTaskReadCursorKey(agentId))?.value
    const ms = raw ? Date.parse(raw) : Number.NaN
    return Number.isFinite(ms) ? ms : 0
  } catch {
    return 0
  }
}

/** 把未读游标推到 `at`（见 {@link readPetTaskReadCursor}） */
export function writePetTaskReadCursor(db: DatabaseAdapter, agentId: string, at: string): void {
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(petTaskReadCursorKey(agentId), at, at)
}

/**
 * 控制坞那一区要读的全部内容：进行中的一件 + 结果回执（新的在前）+ 未读数。
 *
 * 一行 SQL 粗筛、每个候选再走一遍 {@link readPetTaskMetadata} 精筛：
 * SQL 那句 `LIKE '%pet-task%'` 只是**便宜的预筛**（它连 `{"source":"pet-task"}` 的
 * 键序都不保证，将来换写法就漏），真正的判据是那个解析器。
 */
export function readPetTaskState(db: DatabaseAdapter, agentId: string): PetTaskStateDTO {
  const cursor = readPetTaskReadCursor(db, agentId)
  const rows = listRows(db, agentId)

  /**
   * **两趟**，不是一趟。一趟写（边挑 running 边填 items、填满就 break）有个顺序假设：
   * "进行中那件一定在最新的几条里"。单飞锁让它一般成立，但"一般"不够——
   * 一件卡住的旧目标 + 二十条新回执时，`running` 会被 break 跳过，
   * 表现为控制坞里**没有"正在看"那一条**（用户点完按钮看不见它动）。
   *
   * 两趟的代价是一次数组遍历（几十行），换掉一个不该存在的假设。
   */
  let running: PetTaskStateDTO['running'] = null
  for (const row of rows) {
    const meta = readPetTaskMetadata(row.metadata)
    if (!meta || meta.result) continue
    if (row.status !== 'executing') continue
    running = { id: row.id, description: row.description, startedAt: row.created_at }
    break // rows 新的在前 → 第一条命中的就是最新的那件
  }

  const items: PetTaskItemDTO[] = []
  for (const row of rows) {
    if (items.length >= PET_TASK_LIST_LIMIT) break
    const meta = readPetTaskMetadata(row.metadata)
    if (!meta?.result) continue
    if (row.id === running?.id) continue

    const at = Date.parse(meta.result.at)
    items.push({
      id: row.id,
      description: row.description,
      ok: meta.result.ok,
      text: meta.result.text,
      at: meta.result.at,
      unread: Number.isFinite(at) ? at > cursor : false,
    })
  }

  return { running, items, unread: items.filter((i) => i.unread).length }
}
