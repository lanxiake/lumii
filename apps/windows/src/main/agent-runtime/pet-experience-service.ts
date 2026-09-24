/**
 * 宠物经历的服务层：上报入口（T7.1）与「经历」页（T7.6）
 *
 * ---------------------------------------------------------------------------
 * 六条信号，两个入口
 * ---------------------------------------------------------------------------
 * | 谁看得见 | 信号 | 走哪 |
 * |---|---|---|
 * | **只有渲染层** | 气泡被点 / 气泡没人理 / 摸它 / 控制坞回话 | `pet:experience:report`（本文件） |
 * | 主进程自己 | 派了一件活 / 看了回执 | `pet-task-service` 直接写 |
 *
 * 后两条不绕 IPC 是刻意的：用户点"让它去做"的那一下，主进程**就在受理函数里**，
 * 让渲染层再报一次等于为同一件事造两个真相源（其中一个还会漏——比如 CLI 派活时
 * 根本没有渲染层）。两条路最终都落到 `appendPetExperience` 这一份流水上。
 *
 * ---------------------------------------------------------------------------
 * 「经历」页为什么是"问一次"而不是事件流
 * ---------------------------------------------------------------------------
 * 它是设计 §8.4 说的**证据页**：用户来这里看的是"它真的变了"这个累积的事实，
 * 不是此刻的状态灯。事件流要维护订阅、重连、乱序，而这里挂载时问一次就够
 * （与 `pet:task:state` 同一条取舍）。
 */

import {
  PersonalityTracker,
  EMA_ALPHA,
  appendPetExperience,
  listRecentDiaries,
  readBirthSnapshot,
  readPetTaskMetadata,
  isPetExperienceKind,
  type DatabaseAdapter,
} from '@mtbot/agent-runtime'
import type { PetExperienceDTO } from '../../shared/pet-mode'
import { currentPetAgentId } from '../pet/pet-subject'
import { getAgentRuntimeBridge } from '../ipc/agent-runtime-ipc'
import { toAsyncClient } from './autonomous-wiring'
import { toTraitValues } from './pet-personality'
import { agentRuntimeLog as log } from './bridge-utils'

/** 「做过的事」列多少条 */
const WORKS_LIMIT = 20
/** 日记列多少篇 */
const DIARIES_LIMIT = 5

/**
 * 渲染层上报一条"用户对它的反应"（第七期 T7.1）。
 *
 * 参数收 `unknown` 并在**这里**校验：IPC 那头传什么都可能，而拼错的 kind
 * 会被静静写进库——反思侧读到的是一堆它不认识的信号，不报错，
 * 只是那只宠物"好像没人理"。校验器与类型同源（`PET_EXPERIENCE_KINDS`）。
 *
 * 拿不到当前宠物（不在宠物模式 / bridge 没起）就什么都不做——
 * **不报错、不回落**：这个身份的隔离正是 §3.7 要的，写错人比不写更糟。
 */
export function reportPetExperience(kind: unknown): void {
  if (!isPetExperienceKind(kind)) return
  const bridge = getAgentRuntimeBridge()
  const agentId = currentPetAgentId()
  if (!bridge || !agentId) return
  appendPetExperience(bridge.db, agentId, kind)
}

/**
 * 读「经历」页的全部内容（第七期 T7.6）。
 *
 * 四个来源**全部是已有数据**（设计 §11.4 逐条核实过）：
 * `runtime_state['personality:birth:<id>']` / `personality_state` /
 * `autonomous_goals` / `autonomous_diaries`。本期只是把它们读出来。
 *
 * bridge 未就绪 / 不在宠物模式 → `null`，渲染层按"还读不到"处理。
 */
export async function getPetExperience(): Promise<PetExperienceDTO | null> {
  const bridge = getAgentRuntimeBridge()
  const agentId = currentPetAgentId()
  if (!bridge || !agentId) return null

  const db = bridge.db

  /**
   * 当前性格走 `getCurrentState` —— **首次读即出生**（抽签 + 落快照）。
   *
   * 这不是副作用泄漏，是设计 §3.2 的惰性出生：经历页是用户看"它出生时什么样"
   * 的地方，第一次打开它就该看到一签已经抽好了，而不是一个空页。
   * 已有快照时它是一次主键读。
   */
  let current: PetExperienceDTO['current'] = null
  try {
    const tracker = new PersonalityTracker(
      { emaAlpha: EMA_ALPHA, eventWeights: {}, trackingEnabled: true },
      toAsyncClient(db),
    )
    const state = await tracker.getCurrentState(agentId)
    current = {
      traits: toTraitValues(state),
      lastUpdated: state.lastUpdated,
      updateCount: state.updateCount,
    }
  } catch (err) {
    log.warn(`[getPetExperience] 读当前性格失败 agent=${agentId}:`, err instanceof Error ? err.message : err)
  }

  const birth = readBirthSnapshot(db, agentId)
  const works = listWorks(db, agentId)
  let diaries: PetExperienceDTO['diaries'] = []
  try {
    diaries = listRecentDiaries(db, agentId, DIARIES_LIMIT).map((d) => ({
      date: d.diaryDate,
      content: d.content,
    }))
  } catch (err) {
    log.warn(`[getPetExperience] 读日记失败 agent=${agentId}:`, err instanceof Error ? err.message : err)
  }

  return {
    birth: birth ? { at: birth.at, migrated: birth.migrated === true, traits: birth.traits } : null,
    current,
    works,
    diaries,
  }
}

interface GoalRow {
  id: string
  description: string
  status: string
  completed_at: string | null
  created_at: string
  metadata: string | null
}

/**
 * 「做过的事」：宠物自己的目标里**已经收尾的**那些（新的在前）。
 *
 * 判据取 `planned_by = 'pet'`（用户交代的与自己排的都是它），再用
 * `readPetTaskMetadata` 精筛——与 `pet-task-store.listRows` 同一条纪律：
 * SQL 的 `LIKE` 只是便宜预筛，真正的判据是那个解析器。
 *
 * 进行中的不在这一页：经历页要的是"发生过什么"，而"正在做什么"是控制坞那一栏的事。
 * 两边各说各的，不重复。
 */
function listWorks(db: DatabaseAdapter, agentId: string): PetExperienceDTO['works'] {
  try {
    const rows = db
      .prepare<GoalRow>(
        `SELECT id, description, status, completed_at, created_at, metadata
           FROM autonomous_goals
          WHERE agent_id = ? AND planned_by = 'pet' AND status IN ('completed', 'failed')
          ORDER BY COALESCE(completed_at, created_at) DESC
          LIMIT ?`,
      )
      .all(agentId, WORKS_LIMIT)

    const works: PetExperienceDTO['works'] = []
    for (const row of rows) {
      const meta = readPetTaskMetadata(row.metadata)
      if (!meta) continue
      works.push({
        id: row.id,
        description: row.description,
        // 终态是权威：回执缺失时按目标状态判（回执写库失败不该让它变成"没做过"）
        ok: meta.result?.ok ?? row.status === 'completed',
        at: meta.result?.at ?? row.completed_at ?? row.created_at,
        text: meta.result?.text ?? '',
      })
    }
    return works
  } catch (err) {
    log.warn(`[getPetExperience] 读做过的事失败 agent=${agentId}:`, err instanceof Error ? err.message : err)
    return []
  }
}
