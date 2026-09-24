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

/**
 * ⚠ 探测不到 FTS5 测试库时**必须红**，不能像其余文件那样一路 `describe.skipIf` 静默跳过。
 *
 * 理由：这个文件守的是三期最关键的两道硬闸门（T3.4），而 `skipIf` 的失败形态是
 * "文件全绿、退出码 0、一条闸门断言都没跑"（实测 `3 skipped (3)`，退出码 0）——
 * 于是"两道硬闸门已验证"这个结论在环境坏掉时**没有任何机器保证**。
 * 别的文件可以 skip（守的是行为细节），这个不行：宁可红一次去修环境。
 *
 * `skipIf` 保留在下面：环境坏时不该再泼一屏"no such table"式的次生失败，
 * 一条说得清的失败 + 若干 SKIP 比一百条报错好读。
 */
describe('宠物派发测试的前置条件', () => {
  it('测试库必须带 FTS5（否则下面的硬闸门用例会全部被跳过）', () => {
    expect(
      hasFts5Db,
      '测试库没有 FTS5：better-sqlite3 可能没重建' +
        '（pnpm --filter @mtbot/agent-runtime rebuild better-sqlite3），或 node:sqlite 未启用。' +
        '修好之前，本文件守的两道硬闸门等于没跑。',
    ).toBe(true)
  })
})

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
  /**
   * 默认实现模拟 bridge 的契约：**跑完就落终态**。
   *
   * 不落终态的话"今天跑过几条"永远不动，闸门用例就是在测一个假世界——
   * 而闸门的判据正是"跑过几条"。
   */
  const executePetGoal = vi.fn(async (goal: PetGoalSignal) => {
    db.prepare(`UPDATE autonomous_goals SET status = 'completed', completed_at = ? WHERE id = ?`).run(
      nowIso(),
      goal.id,
    )
    return 'completed'
  })
  const reportGoalResult = vi.fn()
  return {
    deps: {
      getDb: () => db,
      findActivePetAgent: () => null,
      executePetGoal,
      reportGoalResult,
      now: () => new Date('2026-09-24T12:00:00.000Z'),
      ...overrides,
    } satisfies PetDispatchDeps,
    executePetGoal,
    reportGoalResult,
  }
}

/** 测试基准时刻（本地当天 12:00）——日界取本地零点，不能写死 UTC 串 */
const NOW = new Date('2026-09-24T12:00:00.000Z')
/** 本地当天某钟点 → ISO */
const todayIso = (hour: number) =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour, 0, 0).toISOString()
/** 落终态用的时间戳：与 `NOW` 同一天，免得测试随真实时钟跨日而漂 */
const nowIso = () => todayIso(12)

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

  /**
   * 五期 T5.9：「允许宠物主动做事」关掉之后，心跳一拍都不该动。
   *
   * 与 job 的 `enabled` 是**两道**（那个管调度器要不要跑，这里管此刻用户的意愿），
   * 所以这里要单独钉一条——只留 enabled 的话，用户手点任务页就能绕过设置页那个开关。
   */
  describe('总开关（T5.9）', () => {
    it('关掉 → 跳过，且一个目标都不动', async () => {
      insertGoal(db, { id: 'g-1' })
      const { deps, executePetGoal, reportGoalResult } = makeDeps(db, {
        isPetTaskEnabled: () => false,
      })
      expect(await runPetDispatch(deps)).toBe('skipped: pet task disabled')
      expect(executePetGoal).not.toHaveBeenCalled()
      // 也不该发回执：这不是"办砸了"，是"没办"——没有回执可报
      expect(reportGoalResult).not.toHaveBeenCalled()
    })

    it('目标**留在原地**（不是丢弃）—— 开关再打开时它还该被捞起来', async () => {
      insertGoal(db, { id: 'g-1' })
      await runPetDispatch(makeDeps(db, { isPetTaskEnabled: () => false }).deps)
      const row = db
        .prepare<{ status: string; completed_at: string | null }>(
          `SELECT status, completed_at FROM autonomous_goals WHERE id = 'g-1'`,
        )
        .get()
      expect(row).toEqual({ status: 'executing', completed_at: null })
    })

    it('开着（或缺省没给这个依赖）→ 照常跑', async () => {
      insertGoal(db, { id: 'g-1' })
      expect(await runPetDispatch(makeDeps(db, { isPetTaskEnabled: () => true }).deps)).toBe(
        'pet-goal: completed',
      )
      // 对照组：不给这个依赖时行为不变（旧调用点与单测不必跟着改）
      db = createMigratedDb()
      insertGoal(db, { id: 'g-1' })
      expect(await runPetDispatch(makeDeps(db).deps)).toBe('pet-goal: completed')
    })

    it('关掉时**排在让路之前**：用户回合在跑 + 开关关着，报的是开关', async () => {
      // 顺序有语义：这句话是给"为什么它不动"的排查用的。开关关着是用户自己的决定，
      // 比"用户回合在跑"更该报出来（后者是暂态，前者是配置）
      insertGoal(db, { id: 'g-1' })
      const { deps } = makeDeps(db, {
        isPetTaskEnabled: () => false,
        hasActiveUserTurn: () => true,
      })
      expect(await runPetDispatch(deps)).toBe('skipped: pet task disabled')
    })
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

  /**
   * 第二道锁（2026-09-24 复审补的回归用例）：单飞锁挡不住**同时进来的两拍**。
   *
   * `findActivePetAgent` 在第一个 await **之前**求值，而实例要等 `createInstance` 里若干 await
   * 之后才进注册表——那个窗口里第二拍看到的仍是"没有宠物实例"，于是同一个目标被跑两遍
   * （两次模型往返、两次记账、两条回执），而且 `finalizeGoal` 是无条件 UPDATE，
   * 后跑完的那次还能把 `completed` 覆写成 `failed`。
   *
   * 真实触发形态：用户点「让它去做」的那一脚（受理后立刻派发）撞上 5 分钟一拍的 cron 心跳。
   */
  it('上一拍还没收尾 → 第二拍直接跳过（手动踢的那一脚 × cron 心跳）', async () => {
    insertGoal(db, { id: 'g-1' })
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const executePetGoal = vi.fn(async (goal: PetGoalSignal) => {
      await gate // 卡在"实例创建中"那个窗口
      db.prepare(`UPDATE autonomous_goals SET status = 'completed', completed_at = ? WHERE id = ?`).run(
        nowIso(),
        goal.id,
      )
      return 'completed'
    })
    const { deps } = makeDeps(db, { executePetGoal })

    // 不 await：第一拍已经进到执行里了
    const first = runPetDispatch(deps)
    expect(await runPetDispatch(deps)).toBe('skipped: already dispatching')

    release()
    expect(await first).toBe('pet-goal: completed')
    expect(executePetGoal).toHaveBeenCalledTimes(1)
    // 收尾后锁要放开——否则宠物从此再也不动（下一拍仍有活时能照常派）
    insertGoal(db, { id: 'g-2', createdAt: '2026-09-24T10:01:00.000Z' })
    expect(await runPetDispatch(deps)).toBe('pet-goal: completed')
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

describe.skipIf(!hasFts5Db)('宠物硬闸门（T3.2 的常量，判定在派发侧）', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
  })

  const petTokenKey = (agentId: string) => {
    const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate())
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return `autonomous.tokens:${agentId}:${day}`
  }

  const statusCounts = () =>
    db
      .prepare<{ status: string; count: number }>(
        `SELECT status, COUNT(*) as count FROM autonomous_goals GROUP BY status`,
      )
      .all()

  /**
   * ⚠ 这条是 2026-09-24 修正的回归测试。
   *
   * 原判据数的是"今天**建**了几条"，于是批量入队时第一拍就判超额：6 条排队 → 计数 6 →
   * **每条都被拒** → 当天 6 条目标一条 completed 都没有（真机日志里的
   * `refused: 今日目标已用满（6/5）`）。越额只该影响越额的那一条。
   */
  it('一次排队 6 条：前 5 条照跑，只有越额的那一条被拒', async () => {
    for (let i = 0; i < 6; i += 1) {
      insertGoal(db, { id: `g-${i}`, createdAt: todayIso(10) })
    }
    const { deps, executePetGoal } = makeDeps(db, { now: () => NOW })

    const summaries: string[] = []
    for (let i = 0; i < 6; i += 1) summaries.push(await runPetDispatch(deps))

    expect(executePetGoal).toHaveBeenCalledTimes(5)
    expect(summaries.slice(0, 5)).toEqual(Array(5).fill('pet-goal: completed'))
    expect(summaries[5]).toBe('refused: 今日目标已用满（5/5）')
    expect(statusCounts()).toEqual(
      expect.arrayContaining([
        { status: 'completed', count: 5 },
        { status: 'failed', count: 1 },
      ]),
    )
    // 第 7 拍没有活可派（被拒那条已落终态，不会每 5 分钟被重捞）
    expect(await runPetDispatch(deps)).toBe('idle: no-pet-goal')
  })

  it('被拒也要有回执（用户交代的事不能静默消失）', async () => {
    for (let i = 0; i < 6; i += 1) {
      insertGoal(db, { id: `g-${i}`, createdAt: todayIso(10) })
    }
    const { deps, reportGoalResult } = makeDeps(db, { now: () => NOW })
    for (let i = 0; i < 6; i += 1) await runPetDispatch(deps)

    expect(reportGoalResult).toHaveBeenCalledTimes(1)
    const [goal, ok, text] = reportGoalResult.mock.calls[0]
    expect(goal.id).toBe('g-5')
    expect(ok).toBe(false)
    expect(text).toContain('今日目标已用满')
  })

  it('今日预算不足 → 拒绝', async () => {
    insertGoal(db, { id: 'g-1', createdAt: todayIso(10) })
    db.prepare(
      `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, '40000', ?)`,
    ).run(petTokenKey('pet:demo_cartoon_cat'), new Date().toISOString())

    const { deps, executePetGoal, reportGoalResult } = makeDeps(db, { now: () => NOW })
    const result = await runPetDispatch(deps)

    expect(result).toContain('refused: 今日预算不足')
    expect(executePetGoal).not.toHaveBeenCalled()
    expect(reportGoalResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'g-1' }),
      false,
      expect.stringContaining('今日预算不足'),
    )
  })

  it('助手的账不会影响宠物：助手今天用满了，宠物照跑', async () => {
    insertGoal(db, { id: 'g-1', createdAt: todayIso(10) })
    db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, '40000', ?)`).run(
      petTokenKey('assistant'),
      new Date().toISOString(),
    )

    const { deps } = makeDeps(db, { now: () => NOW })
    expect(await runPetDispatch(deps)).toBe('pet-goal: completed')
  })

  it('跑完记在**宠物**账上，不是助手账上', async () => {
    insertGoal(db, { id: 'g-1', createdAt: todayIso(10) })
    const { deps } = makeDeps(db, { now: () => NOW })
    await runPetDispatch(deps)

    const read = (key: string) =>
      db.prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`).get(key)?.value
    expect(read(petTokenKey('pet:demo_cartoon_cat'))).toBe('8000')
    expect(read(petTokenKey('assistant'))).toBeUndefined()
  })

  /**
   * 执行抛错这条路原本什么都不收尾：目标停在 `executing`（`scheduled_for` 已到期），
   * 5 分钟后被 `listDuePetGoals` 再捞起来 —— 无限重跑无退避，而且**两道闸门都拦不住**
   * （次数门数的是"跑过几条"，重试不增加；预算门读的记账恒为 0）。
   */
  it('执行抛错：落终态 + 记账 + 发回执，且不会被下一拍重捞', async () => {
    insertGoal(db, { id: 'g-1', createdAt: todayIso(10) })
    const executePetGoal = vi.fn(async () => {
      throw new Error('实例创建失败')
    })
    const { deps, reportGoalResult } = makeDeps(db, { executePetGoal, now: () => NOW })

    // 外层仍然是"不炸穿调度层、返回可读 error 串"（这条契约没变）
    expect(await runPetDispatch(deps)).toBe('error: 实例创建失败')

    const goal = db
      .prepare<{ status: string; completed_at: string | null }>(
        `SELECT status, completed_at FROM autonomous_goals WHERE id = 'g-1'`,
      )
      .get()
    expect(goal?.status).toBe('failed')
    expect(goal?.completed_at).toBeTruthy()

    // 钱是真花了（模型往返发生过），账要记
    const tokens = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(petTokenKey('pet:demo_cartoon_cat'))?.value
    expect(tokens).toBe('8000')

    expect(reportGoalResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'g-1' }),
      false,
      '实例创建失败',
    )
    // 关键：下一拍不再有活可派——这就是"无限重跑"那条路的封口
    expect(await runPetDispatch(deps)).toBe('idle: no-pet-goal')
  })
})

/**
 * P3 断言（计划 §五「★ 断言：播报不经过 dispatchNotifications」）。
 *
 * `executePetGoal` 住在 bridge 里，整个类要跑起来才能单测（代价远超这条断言的价值），
 * 所以这里改成**读源码**：把那个方法的函数体抠出来，断言它一次都没提通知。
 *
 * 为什么值得单独立一条：`executeGoal`（自主进化那条路）**是发系统通知的**——
 * 照抄它就会让同一件事既冒宠物气泡又弹系统通知。这个错误不报错、单元测试也照过，
 * 只有用户会觉得"怎么说了两遍"。
 */
describe('P5/P3 守卫：宠物的播报通道只有气泡', () => {
  /** 抠出 `private async executePetGoal(...) { ... }` 的方法体（按大括号配平） */
  function extractMethodBody(source: string, signature: string): string | null {
    const start = source.indexOf(signature)
    if (start < 0) return null
    const open = source.indexOf('{', start)
    if (open < 0) return null
    let depth = 0
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) return source.slice(open, i + 1)
      }
    }
    return null
  }

  /**
   * 剥掉注释再断言。
   *
   * ⚠️ 第一版没剥，结果被**我自己写在方法里的注释**绊倒了——那句注释正好在解释
   * "不走 `showCronNotification`"。判定必须只看**代码**：注释里提一句不代表调用了，
   * 而一个会被注释绊倒的守卫，最后一定会被人用改注释的方式绕过。
   */
  function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  }

  it('executePetGoal 不碰 showCronNotification / dispatchNotifications', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const bridgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge.ts')
    const body = extractMethodBody(readFileSync(bridgePath, 'utf8'), 'private async executePetGoal')

    // 抠取失败必须让测试红——否则这条守卫会变成永不失败的摆设
    expect(body, '没能从 bridge.ts 抠出 executePetGoal（方法被改名/挪走了？）').toBeTruthy()
    expect(body!.length, 'executePetGoal 的方法体短得可疑，抠取可能搞错了').toBeGreaterThan(300)

    const code = stripComments(body!)
    // 剥注释不能把代码也剥没了（正则写坏时这条会红）
    expect(code).toContain('finalizeGoal')

    expect(code).not.toContain('showCronNotification')
    expect(code).not.toContain('dispatchNotifications')
  })

  it('对照组：executeGoal（自主进化那条路）确实发系统通知——所以上面那条不是空断言', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const bridgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge.ts')
    const source = readFileSync(bridgePath, 'utf8')
    const body = extractMethodBody(source, 'executeGoal: async (goal, agentId, selfCheckBias) =>')
    expect(body, '没能抠出 executeGoal').toBeTruthy()
    expect(body).toContain('showCronNotification')
  })
})
