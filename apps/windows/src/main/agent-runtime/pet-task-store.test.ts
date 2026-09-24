/**
 * 宠物任务落库层的测试（五期 T5.3 / T5.4 / T5.8）。
 *
 * 这一层之所以存在、且能被这样测，是因为它**只吃 `db` 参数**：不 import Electron、
 * 不 import bridge（理由见文件头——`bridge.ts` 要用它，反向 import 会绕出环）。
 * 副作用所以都在这里，判据（接不接、怎么说）在 `packages/agent-runtime` 的
 * `pet-task.ts` 里，那边是纯的、另有一份测试。
 *
 * ⚠ 最容易出的错是**"没测过"被当成"中等水平"**：`CapabilityTracker.getCapabilityState`
 * 对不存在的行返回 `{level: 0.5, testCount: 0}`，直接拿来用，宠物就会凭一个从没测过的
 * 0.5 说"我拿手/我不拿手"。`readPetTaskBoundary` 那几条钉的就是这个。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { CapabilityDimension, type DatabaseAdapter } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../packages/agent-runtime/src/storage/schema'
import { createTestSqliteAdapter } from '../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import {
  hasRunningPetTask,
  persistPetTaskReceipt,
  readPetTaskBoundary,
  readPetTaskDimension,
  readPetTaskReadCursor,
  readPetTaskState,
  recordPetTaskOutcome,
  writePetTaskReadCursor,
} from './pet-task-store'

const PET = 'pet:demo_cartoon_cat'
const OTHER_PET = 'pet:mao_pro'

const hasFts5Db = (() => {
  try {
    const db = createTestSqliteAdapter()
    db.close()
    return true
  } catch {
    return false
  }
})()

function createMigratedDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter()
  for (const [, sql] of MIGRATIONS) db.exec(sql)
  return db
}

/** 插一条目标行。`metadata` 缺省就是一条**刚受理、还没回执**的宠物任务 */
function insertGoal(
  db: DatabaseAdapter,
  opts: {
    id: string
    agentId?: string
    description?: string
    status?: string
    metadata?: string | null
    createdAt?: string
    completedAt?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO autonomous_goals
       (id, agent_id, type, description, trigger_reason, status, priority, metadata,
        created_at, completed_at, planned_by)
     VALUES (?, ?, 'learning', ?, '用户交代', ?, 1, ?, ?, ?, 'pet')`,
  ).run(
    opts.id,
    opts.agentId ?? PET,
    opts.description ?? '看看测试挂了没',
    opts.status ?? 'executing',
    opts.metadata === undefined ? '{"source":"pet-task","dimension":"code_generation"}' : opts.metadata,
    opts.createdAt ?? '2026-09-24T10:00:00.000Z',
    opts.completedAt ?? null,
  )
}

/** 一条带回执的目标（= 已经报回来过） */
function insertFinished(
  db: DatabaseAdapter,
  id: string,
  ok: boolean,
  text: string,
  at: string,
  agentId = PET,
): void {
  insertGoal(db, {
    id,
    agentId,
    status: ok ? 'completed' : 'failed',
    completedAt: at,
    createdAt: at,
    metadata: JSON.stringify({
      source: 'pet-task',
      dimension: 'code_generation',
      result: { ok, text, at },
    }),
  })
}

describe.skipIf(!hasFts5Db)('宠物任务落库层', () => {
  let db: DatabaseAdapter
  beforeEach(() => {
    db = createMigratedDb()
  })

  describe('hasRunningPetTask —— 单飞锁的判据', () => {
    it('受理了、还没回执 → 在手头', () => {
      insertGoal(db, { id: 'g1' })
      expect(hasRunningPetTask(db, PET)).toBe(true)
    })

    it('已经收尾（有 result）→ 不在手头', () => {
      insertFinished(db, 'g1', true, '测试全过', '2026-09-24T10:05:00.000Z')
      expect(hasRunningPetTask(db, PET)).toBe(false)
    })

    it('别人（别的宠物）的在手头不算我的', () => {
      insertGoal(db, { id: 'g1', agentId: OTHER_PET })
      expect(hasRunningPetTask(db, PET)).toBe(false)
      // 对照组：同一个判据换成它自己的 agentId 就是 true——
      // 否则"查询写错 agentId"也会让上面那条通过
      expect(hasRunningPetTask(db, OTHER_PET)).toBe(true)
    })

    it('非宠物任务（别人的 metadata）不算', () => {
      insertGoal(db, { id: 'g1', metadata: '{"source":"reflection-suggestion"}' })
      expect(hasRunningPetTask(db, PET)).toBe(false)
    })
  })

  describe('未读游标', () => {
    it('没写过 → 0（历史回执全部算未读）', () => {
      // 这一条是设计 §4.2.2 的落点：用户交代了事出去倒水，回来必须看得到。
      // 默认成"now"会把第一次打开坞之前的回执全标成已读——恰好把要保的丢了
      expect(readPetTaskReadCursor(db, PET)).toBe(0)
    })

    it('写过就读得回来，且按宠物分键', () => {
      writePetTaskReadCursor(db, PET, '2026-09-24T12:00:00.000Z')
      expect(readPetTaskReadCursor(db, PET)).toBe(Date.parse('2026-09-24T12:00:00.000Z'))
      expect(readPetTaskReadCursor(db, OTHER_PET)).toBe(0)
    })

    it('重复写是覆盖，不是插两行', () => {
      writePetTaskReadCursor(db, PET, '2026-09-24T12:00:00.000Z')
      writePetTaskReadCursor(db, PET, '2026-09-24T13:00:00.000Z')
      expect(readPetTaskReadCursor(db, PET)).toBe(Date.parse('2026-09-24T13:00:00.000Z'))
      const n = db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM runtime_state WHERE key LIKE 'pet.task.readAt:%'`)
        .get()
      expect(n?.n).toBe(1)
    })
  })

  describe('readPetTaskState —— 控制坞那一区', () => {
    it('进行中的那件单独出来，不进回执列表', () => {
      insertGoal(db, { id: 'g1', description: '看看测试挂了没' })
      insertFinished(db, 'g2', true, '测试全过', '2026-09-24T09:00:00.000Z')

      const state = readPetTaskState(db, PET)
      expect(state.running).toEqual({
        id: 'g1',
        description: '看看测试挂了没',
        startedAt: '2026-09-24T10:00:00.000Z',
      })
      expect(state.items.map((i) => i.id)).toEqual(['g2'])
    })

    it('回执新的在前', () => {
      insertFinished(db, 'old', true, '早', '2026-09-24T08:00:00.000Z')
      insertFinished(db, 'new', true, '晚', '2026-09-24T11:00:00.000Z')
      // created_at 决定顺序（回执时刻与它一致，见 fixture）
      const state = readPetTaskState(db, PET)
      expect(state.items.map((i) => i.id)).toEqual(['new', 'old'])
    })

    it('未读：游标之后的有标记，之前的没有', () => {
      insertFinished(db, 'old', true, '早', '2026-09-24T08:00:00.000Z')
      insertFinished(db, 'new', true, '晚', '2026-09-24T11:00:00.000Z')
      writePetTaskReadCursor(db, PET, '2026-09-24T09:00:00.000Z')

      const state = readPetTaskState(db, PET)
      expect(state.items.find((i) => i.id === 'old')?.unread).toBe(false)
      expect(state.items.find((i) => i.id === 'new')?.unread).toBe(true)
      expect(state.unread).toBe(1)
    })

    it('全都看过了 → 未读数是 0', () => {
      insertFinished(db, 'a', true, 'x', '2026-09-24T08:00:00.000Z')
      writePetTaskReadCursor(db, PET, '2026-09-24T12:00:00.000Z')
      const state = readPetTaskState(db, PET)
      expect(state.unread).toBe(0)
      expect(state.items[0]?.unread).toBe(false)
    })

    it('失败的也进列表，且 ok=false（"没办成"必须看得出来）', () => {
      insertFinished(db, 'bad', false, '没能做成：文件不存在', '2026-09-24T10:00:00.000Z')
      const state = readPetTaskState(db, PET)
      expect(state.items[0]?.ok).toBe(false)
      expect(state.items[0]?.text).toContain('文件不存在')
    })

    it('不是宠物任务的行一律不进来（别人的 metadata 不该被当成它的回执）', () => {
      insertGoal(db, { id: 'x', metadata: '{"source":"reflection-suggestion"}' })
      insertGoal(db, { id: 'y', metadata: '{"lowestDimension":"feedback","lowestDimensionScore":0.35}' })
      insertGoal(db, { id: 'z', metadata: null })
      const state = readPetTaskState(db, PET)
      expect(state.items).toEqual([])
      expect(state.running).toBeNull()
    })

    it('别的宠物的不进来', () => {
      insertFinished(db, 'theirs', true, '别人的', '2026-09-24T10:00:00.000Z', OTHER_PET)
      expect(readPetTaskState(db, PET).items).toEqual([])
      // 对照组
      expect(readPetTaskState(db, OTHER_PET).items).toHaveLength(1)
    })

    it('空库返回空结构，不是 null', () => {
      expect(readPetTaskState(db, PET)).toEqual({ running: null, items: [], unread: 0 })
    })

    it('进行中的那件**比回执旧**时也照样挑得出来', () => {
      // 一趟写（边填 items、填满就 break）会在这里漏掉 running——
      // 单飞锁让它平时不出现，但"平时不出现"不是不变量
      insertGoal(db, { id: 'running', description: '早派的那件', createdAt: '2026-09-24T07:00:00.000Z' })
      insertFinished(db, 'done', true, '后来的回执', '2026-09-24T11:00:00.000Z')

      const state = readPetTaskState(db, PET)
      expect(state.running?.id).toBe('running')
      expect(state.items.map((i) => i.id)).toEqual(['done'])
    })
  })

  describe('persistPetTaskReceipt —— 回执落库', () => {
    it('写上 ok 与原文，且**保住**受理时判出的维度', () => {
      insertGoal(db, { id: 'g1' })
      persistPetTaskReceipt(db, 'g1', false, '没能做成：今日目标已用满（5/5）', '2026-09-24T10:00:00.000Z')

      const row = db
        .prepare<{ metadata: string }>(`SELECT metadata FROM autonomous_goals WHERE id = ?`)
        .get('g1')
      expect(JSON.parse(row!.metadata)).toEqual({
        source: 'pet-task',
        dimension: 'code_generation',
        // origin 也要保住（七期 T7.4）：收尾时手上只有目标行，
        // 把它冲成默认的 user 会让一只自己找事做的宠物在经历页里
        // 变成"全是你让我做的"
        origin: 'user',
        result: { ok: false, text: '没能做成：今日目标已用满（5/5）', at: '2026-09-24T10:00:00.000Z' },
      })
    })

    it('★ origin=self（它自己排的事）在收尾后仍是 self', () => {
      insertGoal(db, {
        id: 'self-1',
        metadata: JSON.stringify({ source: 'pet-task', dimension: null, origin: 'self' }),
      })
      persistPetTaskReceipt(db, 'self-1', true, '看过了', '2026-09-24T10:00:00.000Z')
      const row = db
        .prepare<{ metadata: string }>(`SELECT metadata FROM autonomous_goals WHERE id = ?`)
        .get('self-1')
      expect((JSON.parse(row!.metadata) as { origin?: string }).origin).toBe('self')
    })

    it('**不碰**别人的 metadata（套上 source 会让那些行从此被当成宠物回执）', () => {
      insertGoal(db, { id: 'x', metadata: '{"source":"reflection-suggestion"}' })
      persistPetTaskReceipt(db, 'x', true, 'x', '2026-09-24T10:00:00.000Z')
      const row = db
        .prepare<{ metadata: string }>(`SELECT metadata FROM autonomous_goals WHERE id = ?`)
        .get('x')
      expect(JSON.parse(row!.metadata)).toEqual({ source: 'reflection-suggestion' })
    })

    it('目标不存在时安静返回（不抛）', () => {
      expect(() => persistPetTaskReceipt(db, 'nope', true, 'x', '2026-09-24T10:00:00.000Z')).not.toThrow()
    })

    it('写上回执之后，那条就不再算"在手头"', () => {
      insertGoal(db, { id: 'g1' })
      expect(hasRunningPetTask(db, PET)).toBe(true)
      persistPetTaskReceipt(db, 'g1', true, '看完了', '2026-09-24T10:00:00.000Z')
      // 单飞锁看的是 status，这里顺带确认它不是靠回执判的：
      // 真实收尾由 finalizeGoal 改 status，本函数只写载荷
      expect(hasRunningPetTask(db, PET)).toBe(true)
    })
  })

  describe('readPetTaskDimension', () => {
    it('读得回受理时存下的维度', () => {
      insertGoal(db, { id: 'g1' })
      expect(readPetTaskDimension(db, 'g1')).toBe('code_generation')
    })

    it('判不出维度时是 null，不是 undefined', () => {
      insertGoal(db, { id: 'g1', metadata: '{"source":"pet-task","dimension":null}' })
      expect(readPetTaskDimension(db, 'g1')).toBeNull()
    })

    it('非宠物任务 → null（别把别人的行算成它的账）', () => {
      insertGoal(db, { id: 'x', metadata: '{"source":"planner"}' })
      expect(readPetTaskDimension(db, 'x')).toBeNull()
    })
  })

  describe('readPetTaskBoundary —— "没测过"不是"中等水平"', () => {
    it('没有行 → null（**不是** {level:0.5,testCount:0}）', async () => {
      // 这一条是整个 T5.3 的关口：直接拿 getCapabilityState 的缺省值，
      // 宠物就会凭一个从没测过的 0.5 说"这个我不太拿手"
      await expect(readPetTaskBoundary(db, PET, CapabilityDimension.CODE_GENERATION)).resolves.toBeNull()
    })

    it('维度判不出（null）→ 不读表，直接 null', async () => {
      await expect(readPetTaskBoundary(db, PET, null)).resolves.toBeNull()
    })

    it('有行但 test_count=0 → 仍然 null（写了行不等于测过）', async () => {
      db.prepare(
        `INSERT INTO capability_dimensions
           (agent_id, dimension, level, confidence, boundary, test_count, last_updated)
         VALUES (?, 'code_generation', 0.5, 0, 0.5, 0, ?)`,
      ).run(PET, '2026-09-24T10:00:00.000Z')
      await expect(readPetTaskBoundary(db, PET, CapabilityDimension.CODE_GENERATION)).resolves.toBeNull()
    })

    it('测过 → 给出真实的 level 与样本量', async () => {
      db.prepare(
        `INSERT INTO capability_dimensions
           (agent_id, dimension, level, confidence, boundary, test_count, last_updated)
         VALUES (?, 'code_generation', 0.18, 0.3, 0.18, 4, ?)`,
      ).run(PET, '2026-09-24T10:00:00.000Z')
      await expect(readPetTaskBoundary(db, PET, CapabilityDimension.CODE_GENERATION)).resolves.toEqual({
        level: 0.18,
        testCount: 4,
      })
    })

    it('别人（别的宠物 / 助手）的维度不算它的', async () => {
      db.prepare(
        `INSERT INTO capability_dimensions
           (agent_id, dimension, level, confidence, boundary, test_count, last_updated)
         VALUES ('assistant', 'code_generation', 0.98, 1, 0.98, 53789, ?)`,
      ).run('2026-09-24T10:00:00.000Z')
      // 借助手的成绩当宠物的边界 = 把"装作有"换个姿势（见 pet-task.ts 文件头）
      await expect(readPetTaskBoundary(db, PET, CapabilityDimension.CODE_GENERATION)).resolves.toBeNull()
    })
  })

  describe('recordPetTaskOutcome —— 喂给 Elo 的真实成败', () => {
    it('第一次记账会把行建出来，样本量从 0 到 1', async () => {
      await recordPetTaskOutcome(db, PET, CapabilityDimension.CODE_GENERATION, true, '看看测试挂了没')
      const row = db
        .prepare<{ test_count: number; level: number }>(
          `SELECT test_count, level FROM capability_dimensions WHERE agent_id = ? AND dimension = 'code_generation'`,
        )
        .get(PET)
      expect(row?.test_count).toBe(1)
      // 成功会把 level 从中性往上推（K=0.32，expected=0.5 → +0.16）
      expect(row!.level).toBeGreaterThan(0.5)
    })

    it('失败会把 level 往下拉', async () => {
      await recordPetTaskOutcome(db, PET, CapabilityDimension.CODE_GENERATION, false, '看看测试挂了没')
      const row = db
        .prepare<{ level: number }>(
          `SELECT level FROM capability_dimensions WHERE agent_id = ? AND dimension = 'code_generation'`,
        )
        .get(PET)
      expect(row!.level).toBeLessThan(0.5)
    })

    it('连着栽几次之后，边界真的低到该说"不拿手"', async () => {
      for (let i = 0; i < 4; i += 1) {
        await recordPetTaskOutcome(db, PET, CapabilityDimension.CODE_GENERATION, false, '看看测试挂了没')
      }
      const boundary = await readPetTaskBoundary(db, PET, CapabilityDimension.CODE_GENERATION)
      expect(boundary?.testCount).toBe(4)
      // 与 pet-task.ts 的 PET_TASK_WEAK_LEVEL = 0.35 对齐：四条之后应当已经低于它
      expect(boundary!.level).toBeLessThan(0.35)
    })

    it('维度判不出时什么都不做（这笔账不记在任何维度上）', async () => {
      await recordPetTaskOutcome(db, PET, null, true, '在吗')
      const row = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM capability_dimensions`).get()
      expect(row?.n).toBe(0)
    })

    it('记的是**宠物自己**那一行，不碰助手的', async () => {
      await recordPetTaskOutcome(db, PET, CapabilityDimension.CODE_GENERATION, true, 'x')
      const ids = db
        .prepare<{ agent_id: string }>(`SELECT DISTINCT agent_id FROM capability_dimensions`)
        .all()
        .map((r) => r.agent_id)
      expect(ids).toEqual([PET])
    })
  })
})
