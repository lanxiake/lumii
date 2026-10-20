import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DatabaseAdapter, PetGoalSignal } from '@mtbot/agent-runtime'
import { createTestSqliteAdapter } from '../../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import { MIGRATIONS } from '../../../../../../packages/agent-runtime/src/storage/schema'
import type { InstanceState } from '../bridge-instance-state'
import { PET_GOAL_EXEC_TIMEOUT_MS, runPetGoal, type PetGoalRunnerDeps } from './pet-goal-runner'

/**
 * 宠物目标单轮执行的判据测试。
 *
 * 这段代码原来埋在 `bridge.ts` 的私有方法里，一条测试都写不了——
 * 而它最要紧的恰恰是三个判据（会话先于实例、实例 id 在 try 内赋值、`ok = 有正文 && 无错误`），
 * 每一条都是事故换来的。搬出来就是为了在这里钉住它们。
 */

const hasSqlite = (() => {
  try {
    const db = createTestSqliteAdapter()
    db.close()
    return true
  } catch {
    return false
  }
})()

const AGENT = 'pet:demo_cartoon_cat'
const CONV = 'pet-conv-1'
const GOAL: PetGoalSignal = {
  id: 'goal-1',
  agentId: AGENT,
  type: 'learning',
  description: '把桌面整理一下',
  scheduledFor: null,
}

function createMigratedDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter()
  for (const [, sql] of MIGRATIONS) db.exec(sql)
  return db
}

function insertGoal(db: DatabaseAdapter): void {
  db.prepare(
    `INSERT INTO autonomous_goals
       (id, agent_id, type, description, trigger_reason, status, priority, metadata,
        created_at, completed_at, planned_by)
     VALUES (?, ?, 'learning', ?, '用户交代', 'executing', 1, ?, ?, NULL, 'pet')`,
  ).run(
    GOAL.id,
    AGENT,
    GOAL.description,
    '{"source":"pet-task","dimension":"code_generation"}',
    '2026-09-24T10:00:00.000Z',
  )
}

function readStatus(db: DatabaseAdapter): string | undefined {
  return db.prepare<{ status: string }>('SELECT status FROM autonomous_goals WHERE id = ?')
    .get(GOAL.id)?.status
}

interface Calls {
  moods: string[]
  destroyed: string[]
  reports: Array<{ ok: boolean; text: string }>
  ensured: string[]
  created: string[]
}

function makeDeps(
  db: DatabaseAdapter,
  overrides: Partial<PetGoalRunnerDeps> = {},
): { deps: PetGoalRunnerDeps; calls: Calls } {
  const calls: Calls = { moods: [], destroyed: [], reports: [], ensured: [], created: [] }
  const deps: PetGoalRunnerDeps = {
    db,
    conversationIdFor: () => CONV,
    ensureConversation: (agentId, convId) => calls.ensured.push(`${agentId}/${convId}`),
    createInstance: async (agentId, convId) => {
      calls.created.push(`${agentId}/${convId}`)
      return 'inst-1'
    },
    prompt: async () => {},
    waitForIdle: async () => {},
    assistantOutput: () => '桌面已经整理好了',
    instanceState: () => undefined,
    reportResult: (_goal, ok, text) => calls.reports.push({ ok, text }),
    recordMood: (event) => calls.moods.push(event),
    destroy: (instanceId) => calls.destroyed.push(instanceId),
    ...overrides,
  }
  return { deps, calls }
}

describe.skipIf(!hasSqlite)('runPetGoal', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
    insertGoal(db)
  })

  it('会话先于实例建好，跑完成功：completed + 落终态 + 记 pet_task_done', async () => {
    const { deps, calls } = makeDeps(db)

    await expect(runPetGoal(GOAL, deps)).resolves.toBe('completed')

    expect(calls.ensured).toEqual([`${AGENT}/${CONV}`])
    expect(calls.created).toEqual([`${AGENT}/${CONV}`])
    expect(readStatus(db)).toBe('completed')
    expect(calls.moods).toEqual(['pet_task_done'])
    expect(calls.reports[0]).toEqual({ ok: true, text: '桌面已经整理好了' })
    expect(calls.destroyed).toEqual(['inst-1'])
  })

  it('有正文但本轮报了 LLM 错误 → failed，回执优先给失败原因', async () => {
    const { deps, calls } = makeDeps(db, {
      instanceState: () =>
        ({ lastLlmError: { message: '端点 502' }, lastAborted: false }) as unknown as InstanceState,
    })

    await expect(runPetGoal(GOAL, deps)).resolves.toBe('failed')

    expect(readStatus(db)).toBe('failed')
    expect(calls.moods).toEqual(['pet_task_failed'])
    expect(calls.reports[0]).toEqual({ ok: false, text: '端点 502' })
  })

  it('被中断也算没做成（哪怕吐了半句）', async () => {
    const { deps, calls } = makeDeps(db, {
      instanceState: () => ({ lastAborted: true }) as unknown as InstanceState,
    })

    await expect(runPetGoal(GOAL, deps)).resolves.toBe('failed')
    expect(calls.reports[0]).toEqual({ ok: false, text: '这一轮被中断了' })
  })

  it('没说话 = 没做成：无正文无错误 → empty-output', async () => {
    const { deps, calls } = makeDeps(db, {
      assistantOutput: () => '   ',
      instanceState: () => undefined,
    })

    await expect(runPetGoal(GOAL, deps)).resolves.toBe('empty-output')
    expect(readStatus(db)).toBe('failed')
    expect(calls.moods).toEqual(['pet_task_failed'])
  })

  it('建实例就抛错：不记情绪、不销毁（本来没建起来），但必须落终态并回执', async () => {
    const { deps, calls } = makeDeps(db, {
      createInstance: async () => {
        throw new Error('模型没配好')
      },
    })

    await expect(runPetGoal(GOAL, deps)).resolves.toBe('error: 模型没配好')

    expect(readStatus(db)).toBe('failed')
    // 一次模型往返都没有 → 不能算成"宠物不擅长这类事"
    expect(calls.moods).toEqual([])
    expect(calls.destroyed).toEqual([])
    expect(calls.reports).toEqual([{ ok: false, text: '模型没配好' }])
  })

  it('执行超时也走 catch：落终态 + 回执 + 销毁实例（否则单飞锁永久占着）', async () => {
    const { deps, calls } = makeDeps(db, {
      // 永不 settle：prompt 挂住时 finally 不能依赖它
      prompt: () => new Promise<void>(() => {}),
    })

    vi.useFakeTimers()
    try {
      const promise = runPetGoal(GOAL, deps)
      await vi.advanceTimersByTimeAsync(PET_GOAL_EXEC_TIMEOUT_MS)
      await expect(promise).resolves.toMatch(/^error: 宠物目标执行超时/)
    } finally {
      vi.useRealTimers()
    }

    expect(calls.destroyed).toEqual(['inst-1'])
    expect(readStatus(db)).toBe('failed')
    expect(calls.reports).toEqual([
      { ok: false, text: expect.stringContaining('宠物目标执行超时') },
    ])
  })
})
