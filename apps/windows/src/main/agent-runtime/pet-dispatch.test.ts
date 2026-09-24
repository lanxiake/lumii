/**
 * 宠物派发循环的测试。
 *
 * 循环体本身很薄（找活 → 让路 → 执行），所以这里守的是**四个门闩的顺序与语义**：
 * 退出清场最先、用户回合让路、没活就不动、有活在跑就不重入。
 * 顺序错了不会报错，只会表现为"宠物有时候不动"或"同一只宠物跑了两遍"。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseAdapter, PetGoalSignal } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../packages/agent-runtime/src/storage/schema'
import { createTestSqliteAdapter } from '../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import { isLocalCompanionInstruction } from './local-companion-handler'
import {
  PET_DISPATCH_INSTRUCTION,
  ensurePetDispatchCronJobSeeded,
  runPetDispatch,
  type PetDispatchDeps,
} from './pet-dispatch'

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

function insertGoal(
  db: DatabaseAdapter,
  opts: { id: string; agentId?: string; status?: string; scheduledFor?: string | null; createdAt?: string },
): void {
  db.prepare(
    `INSERT INTO autonomous_goals
     (id, agent_id, type, description, trigger_reason, status, priority, metadata,
      planned_by, scheduled_for, created_at)
     VALUES (?, ?, 'learning', ?, 'user-assigned', ?, 0.5, '{}', 'pet', ?, ?)`,
  ).run(
    opts.id,
    opts.agentId ?? 'pet:demo_cartoon_cat',
    `目标 ${opts.id}`,
    opts.status ?? 'executing',
    opts.scheduledFor ?? null,
    opts.createdAt ?? '2026-09-24T10:00:00.000Z',
  )
}

/** 造一份"什么都顺"的依赖，各用例按需覆盖单项 */
function makeDeps(db: DatabaseAdapter, overrides: Partial<PetDispatchDeps> = {}) {
  const executePetGoal = vi.fn(async (_goal: PetGoalSignal) => 'completed')
  return {
    deps: {
      getDb: () => db,
      findActivePetAgent: () => null,
      executePetGoal,
      now: () => new Date('2026-09-24T12:00:00.000Z'),
      ...overrides,
    } satisfies PetDispatchDeps,
    executePetGoal,
  }
}

describe.skipIf(!hasFts5Db)('runPetDispatch', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
  })

  it('退出清场中直接跳过，不碰库也不执行', async () => {
    insertGoal(db, { id: 'g-1' })
    const { deps, executePetGoal } = makeDeps(db, { isShuttingDown: () => true })
    expect(await runPetDispatch(deps)).toBe('skipped: shutting down')
    expect(executePetGoal).not.toHaveBeenCalled()
  })

  it('真实用户回合进行中 → 让路（后台动作不与用户抢同一个模型端点）', async () => {
    insertGoal(db, { id: 'g-1' })
    const { deps, executePetGoal } = makeDeps(db, { hasActiveUserTurn: () => true })
    expect(await runPetDispatch(deps)).toBe('skipped: user turn in progress')
    expect(executePetGoal).not.toHaveBeenCalled()
  })

  it('没有到期的宠物目标 → 空转，不算失败', async () => {
    const { deps, executePetGoal } = makeDeps(db)
    expect(await runPetDispatch(deps)).toBe('idle: no-pet-goal')
    expect(executePetGoal).not.toHaveBeenCalled()
  })

  it('助手的目标不会把宠物叫起来', async () => {
    insertGoal(db, { id: 'g-assistant', agentId: 'assistant' })
    const { deps } = makeDeps(db)
    expect(await runPetDispatch(deps)).toBe('idle: no-pet-goal')
  })

  it('单飞锁：已有宠物实例在跑 → 跳过，并报出是谁', async () => {
    insertGoal(db, { id: 'g-1' })
    const { deps, executePetGoal } = makeDeps(db, { findActivePetAgent: () => 'pet:mao_pro' })
    expect(await runPetDispatch(deps)).toBe('skipped: busy (pet:mao_pro)')
    expect(executePetGoal).not.toHaveBeenCalled()
  })

  it('一轮只执行一个：还排着队的留到下一拍', async () => {
    insertGoal(db, { id: 'g-1', createdAt: '2026-09-24T10:00:00.000Z' })
    insertGoal(db, { id: 'g-2', createdAt: '2026-09-24T10:01:00.000Z' })
    const { deps, executePetGoal } = makeDeps(db)

    expect(await runPetDispatch(deps)).toBe('pet-goal: completed')
    expect(executePetGoal).toHaveBeenCalledTimes(1)
    // 先派进来的先做
    expect(executePetGoal.mock.calls[0][0]).toMatchObject({ id: 'g-1', agentId: 'pet:demo_cartoon_cat' })
  })

  it('执行抛错不炸穿调度层，返回可读的 error 串', async () => {
    insertGoal(db, { id: 'g-1' })
    const executePetGoal = vi.fn(async () => {
      throw new Error('实例创建失败')
    })
    const { deps } = makeDeps(db, { executePetGoal })
    expect(await runPetDispatch(deps)).toBe('error: 实例创建失败')
  })

  it('依赖里没给可选门闩也能跑（旧调用点不受影响）', async () => {
    insertGoal(db, { id: 'g-1' })
    const { deps } = makeDeps(db)
    // 删掉可选项，模拟最小注入
    delete (deps as { hasActiveUserTurn?: unknown }).hasActiveUserTurn
    delete (deps as { isShuttingDown?: unknown }).isShuttingDown
    expect(await runPetDispatch(deps)).toBe('pet-goal: completed')
  })
})

describe.skipIf(!hasFts5Db)('ensurePetDispatchCronJobSeeded', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
  })

  const readJob = (id: string) =>
    db
      .prepare<{
        task_text: string
        agent_id: string | null
        schedule_type: string
        interval_ms: number
        enabled: number
      }>(`SELECT task_text, agent_id, schedule_type, interval_ms, enabled FROM local_cron_jobs WHERE id = ?`)
      .get(id)

  it('播种出 companion 能拦截的魔法指令形态', () => {
    ensurePetDispatchCronJobSeeded(db)
    const job = readJob('pet-dispatch')
    expect(job).toBeDefined()
    expect(job?.task_text).toBe(PET_DISPATCH_INSTRUCTION)
    // agent_id 必须为 NULL：非空的话 cron 会把它当真实 prompt 喂给某个 Agent
    expect(job?.agent_id).toBeNull()
    expect(job?.schedule_type).toBe('every')
    expect(job?.interval_ms).toBeGreaterThan(0)
    expect(job?.enabled).toBe(1)
  })

  it('指令串与 companion 的拦截集合一致（两处字面量不许漂移）', () => {
    // 常量在 pet-dispatch.ts、拦截名单在 local-companion-handler.ts——两处各写一遍字面量。
    // 改一处忘另一处不会报错，只会表现为"任务在跑，但什么都没发生"。
    expect(isLocalCompanionInstruction(PET_DISPATCH_INSTRUCTION)).toBe(true)
  })

  it('重复播种不产生第二条', () => {
    ensurePetDispatchCronJobSeeded(db)
    ensurePetDispatchCronJobSeeded(db)
    const row = db
      .prepare<{ count: number }>(`SELECT COUNT(*) as count FROM local_cron_jobs WHERE id = 'pet-dispatch'`)
      .get()
    expect(row?.count).toBe(1)
  })

  it('形态自愈，但**不覆盖用户改过的 enabled**', () => {
    ensurePetDispatchCronJobSeeded(db)
    // 用户暂停它，并把它改成了 agent 驱动（历史坑：那样魔法指令会被当 prompt 喂出去）
    db.prepare(
      `UPDATE local_cron_jobs SET enabled = 0, agent_id = 'assistant', schedule_type = 'cron' WHERE id = 'pet-dispatch'`,
    ).run()

    ensurePetDispatchCronJobSeeded(db)

    const job = readJob('pet-dispatch')
    expect(job?.agent_id).toBeNull() // 形态被拉回
    expect(job?.schedule_type).toBe('every')
    expect(job?.enabled).toBe(0) // 用户的暂停被尊重——这一点与 autonomous-tick 刻意不同
  })
})
