/**
 * 宠物自主闭环（反思 + 排期 + 日记）的测试。
 *
 * 守的是**四条纪律**（见 pet-evolve.ts 文件头），它们每一条错了都不会报错：
 * - 冷启动不硬说 → 错了的表现是"刚出生的宠物开口说'我了解你'"
 * - 日界守卫 → 错了的表现是"一小时反思一次，token 悄悄烧掉"
 * - 排期不放宽闸门 → 错了的表现是"它自己找事做把用户的额度吃光"
 * - 日记只写一次 → 错了的表现是"一晚上写十篇"
 */
import { describe, expect, it, vi } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../packages/agent-runtime/src/storage/schema'
import { createTestSqliteAdapter } from '../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import { isLocalCompanionInstruction } from './local-companion-handler'
import { PET_EVOLVE_INSTRUCTION, runPetEvolve, type PetEvolveDeps } from './pet-evolve'

const PET = 'pet:demo_cartoon_cat'

function createMigratedDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter()
  for (const [, sql] of MIGRATIONS) db.exec(sql)
  return db
}

/** 插一条"做过的事"（completed 的宠物任务，带回执） */
function insertWork(
  db: DatabaseAdapter,
  id: string,
  opts: { ok?: boolean; at?: string; description?: string } = {},
): void {
  const at = opts.at ?? new Date(2026, 8, 20, 10, 0, 0).toISOString()
  db.prepare(
    `INSERT INTO autonomous_goals
     (id, agent_id, type, description, trigger_reason, status, priority, metadata,
      planned_by, scheduled_for, created_at, completed_at)
     VALUES (?, ?, 'learning', ?, '用户交代', ?, 1, ?, 'pet', NULL, ?, ?)`,
  ).run(
    id,
    PET,
    opts.description ?? `做过的 ${id}`,
    opts.ok === false ? 'failed' : 'completed',
    JSON.stringify({
      source: 'pet-task',
      dimension: null,
      origin: 'user',
      result: { ok: opts.ok !== false, text: '看过了', at },
    }),
    at,
    at,
  )
}

/** 反思要至少三件"做过的事"才不冷启动 */
function seedEnoughWorks(db: DatabaseAdapter): void {
  insertWork(db, 'w1', { at: new Date(2026, 8, 20, 9, 0, 0).toISOString() })
  insertWork(db, 'w2', { at: new Date(2026, 8, 20, 10, 0, 0).toISOString() })
  insertWork(db, 'w3', { at: new Date(2026, 8, 20, 11, 0, 0).toISOString() })
}

/** 20:00（日记窗已开）、当天 */
const EVENING = () => new Date(2026, 8, 20, 21, 0, 0)

function makeDeps(db: DatabaseAdapter, overrides: Partial<PetEvolveDeps> = {}): PetEvolveDeps {
  return {
    getDb: () => db,
    getPetAgentId: () => PET,
    hasActiveUserTurn: () => false,
    callLLM: async () => '```json\n{"understanding":"他很急","impression":"closer","suggestions":[]}\n```',
    now: EVENING,
    ...overrides,
  }
}

/** LLM 返回两条建议 */
const TWO_SUGGESTIONS =
  '```json\n{"understanding":"他总在下午找我","impression":"closer","suggestions":' +
  '[{"description":"看看今天的日志","reason":"他昨天提过"},{"description":"查一下构建产物","reason":"上次没查完"}]}\n```'

describe('runPetEvolve — 门闩', () => {
  it('退出清场中 → 直接跳过，不碰任何 deps', async () => {
    const db = createMigratedDb()
    const getPetAgentId = vi.fn(() => PET)
    expect(await runPetEvolve(makeDeps(db, { isShuttingDown: () => true, getPetAgentId }))).toBe(
      'skipped: shutting down',
    )
    expect(getPetAgentId).not.toHaveBeenCalled()
  })

  it('用户回合进行中 → 让路（与派发同一条闸门）', async () => {
    const db = createMigratedDb()
    const callLLM = vi.fn(async () => '{}')
    expect(
      await runPetEvolve(makeDeps(db, { hasActiveUserTurn: () => true, callLLM })),
    ).toBe('skipped: user turn in progress')
    expect(callLLM).not.toHaveBeenCalled()
  })

  it('不在宠物模式（拿不到主体）→ 跳过', async () => {
    const db = createMigratedDb()
    expect(await runPetEvolve(makeDeps(db, { getPetAgentId: () => null }))).toBe(
      'skipped: no-pet-agent',
    )
  })

  it('没装配 LLM → 反思那半不做，但不炸', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    expect(await runPetEvolve(makeDeps(db, { callLLM: undefined }))).toContain('reflect: no-llm')
  })
})

describe('runPetEvolve — 冷启动不硬说', () => {
  it('★ 做过的事不足 3 件时不反思，一次 LLM 都不调', async () => {
    const db = createMigratedDb()
    insertWork(db, 'w1')
    insertWork(db, 'w2')
    const callLLM = vi.fn(async () => '{}')
    const result = await runPetEvolve(makeDeps(db, { callLLM }))
    expect(result).toContain('cold-start')
    expect(callLLM).not.toHaveBeenCalled()
  })

  it('★ 冷启动**不标记"今天反思过"**——下午够料了还能反思', async () => {
    const db = createMigratedDb()
    insertWork(db, 'w1')
    insertWork(db, 'w2')
    await runPetEvolve(makeDeps(db, { callLLM: async () => '{}' }))

    // 补上第三件，同一拍再跑一次：应当真的反思（而不是"already-today"）
    insertWork(db, 'w3')
    const callLLM = vi.fn(async () => '{"understanding":"x","impression":"neutral"}')
    const second = await runPetEvolve(makeDeps(db, { callLLM }))
    expect(second).toContain('reflect:')
    expect(callLLM).toHaveBeenCalledTimes(1)
  })
})

describe('runPetEvolve — 日界守卫', () => {
  it('★ 同一天第二次跑 → 不调 LLM', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    const callLLM = vi.fn(async () => '{"understanding":"x","impression":"neutral"}')
    await runPetEvolve(makeDeps(db, { callLLM }))
    expect(callLLM).toHaveBeenCalledTimes(1)

    const second = await runPetEvolve(makeDeps(db, { callLLM }))
    expect(second).toContain('already-today')
    expect(callLLM).toHaveBeenCalledTimes(1)
  })

  it('跨天之后又能反思（守的是"当天"而不是"永远"）', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    const callLLM = vi.fn(async () => '{"understanding":"x","impression":"neutral"}')
    await runPetEvolve(makeDeps(db, { callLLM }))
    await runPetEvolve(
      makeDeps(db, { callLLM, now: () => new Date(2026, 8, 21, 21, 0, 0) }),
    )
    expect(callLLM).toHaveBeenCalledTimes(2)
  })

  it('manual 绕过日界守卫（任务页「立即执行」），但不绕冷启动', async () => {
    const db = createMigratedDb()
    const callLLM = vi.fn(async () => '{"understanding":"x","impression":"neutral"}')
    // 冷启动：manual 也不该让它开口
    insertWork(db, 'early-1')
    insertWork(db, 'early-2')
    expect(await runPetEvolve(makeDeps(db, { callLLM, manual: true }))).toContain('cold-start')
    expect(callLLM).not.toHaveBeenCalled()

    // 够料了：manual 能在当天第二次跑
    insertWork(db, 'w3')
    await runPetEvolve(makeDeps(db, { callLLM }))
    await runPetEvolve(makeDeps(db, { callLLM, manual: true }))
    expect(callLLM).toHaveBeenCalledTimes(2)
  })
})

describe('runPetEvolve — 三样产出', () => {
  it('"我对你的了解" 写进记忆与 runtime_state（两份用途不同）', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    const rememberUnderstanding = vi.fn()
    await runPetEvolve(makeDeps(db, { rememberUnderstanding }))

    expect(rememberUnderstanding).toHaveBeenCalledWith(PET, '他很急')
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(`pet.understanding:${PET}`)
    expect(row?.value).toBe('他很急')
  })

  it('判读 closer → user-feedback-positive；distant → negative', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    const recordPersonality = vi.fn(async () => {})
    await runPetEvolve(
      makeDeps(db, {
        recordPersonality,
        callLLM: async () => '{"understanding":"x","impression":"closer"}',
      }),
    )
    expect(recordPersonality).toHaveBeenCalledWith(
      'user-feedback-positive',
      PET,
      expect.objectContaining({ source: 'pet-reflection' }),
    )

    const db2 = createMigratedDb()
    seedEnoughWorks(db2)
    const record2 = vi.fn(async () => {})
    await runPetEvolve(
      makeDeps(db2, {
        recordPersonality: record2,
        callLLM: async () => '{"understanding":"x","impression":"distant"}',
      }),
    )
    expect(record2).toHaveBeenCalledWith('user-feedback-negative', PET, expect.anything())
  })

  it('impression 是 neutral → 不发人格事件（"没变"也是一种结论）', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    const recordPersonality = vi.fn(async () => {})
    await runPetEvolve(
      makeDeps(db, {
        recordPersonality,
        callLLM: async () => '{"understanding":"x","impression":"neutral"}',
      }),
    )
    expect(recordPersonality).not.toHaveBeenCalled()
  })

  it('★ 建议落成它自己的目标：planned_by=pet 且 origin=self', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    await runPetEvolve(makeDeps(db, { callLLM: async () => TWO_SUGGESTIONS }))

    const rows = db
      .prepare<{ description: string; status: string; planned_by: string; metadata: string }>(
        `SELECT description, status, planned_by, metadata FROM autonomous_goals
          WHERE id LIKE 'pet-self-%'`,
      )
      .all()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].planned_by).toBe('pet')
    expect(rows[0].status).toBe('executing') // 立刻可跑：走的是与用户交代的同一张表
    const meta = JSON.parse(rows[0].metadata) as { origin?: string; dimension?: unknown }
    expect(meta.origin).toBe('self')
    // 自己排的不做能力边界判断（那件事的难度不是它自己说了算的）
    expect(meta.dimension).toBeNull()
  })

  it('★ 排期不放宽闸门：剩余额度不足就不排', async () => {
    const db = createMigratedDb()
    // 已经跑满 4 条（只剩 1 条），留给用户
    for (let i = 0; i < 4; i++) {
      insertWork(db, `w${i}`, { at: new Date(2026, 8, 20, 9 + i, 0, 0).toISOString() })
    }
    await runPetEvolve(makeDeps(db, { callLLM: async () => TWO_SUGGESTIONS }))
    const rows = db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM autonomous_goals WHERE id LIKE 'pet-self-%'`)
      .get()
    expect(rows?.n).toBe(0)
  })

  it('同描述的未完成目标不重复排（反复反思不会攒一堆一样的事）', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    await runPetEvolve(makeDeps(db, { callLLM: async () => TWO_SUGGESTIONS }))
    const landed = db
      .prepare<{ description: string }>(
        `SELECT description FROM autonomous_goals WHERE id LIKE 'pet-self-%'`,
      )
      .all()
    expect(landed.length).toBeGreaterThan(0)

    /**
     * 第二天再反思一次，同样的两条建议。
     *
     * 断言取的是**"同一条描述没有被排两次"**，而不是"总数不变"——
     * 第一次受额度限制只排了第一条，第二次会把第二条补上（那是正常的）。
     */
    await runPetEvolve(
      makeDeps(db, {
        callLLM: async () => TWO_SUGGESTIONS,
        now: () => new Date(2026, 8, 21, 21, 0, 0),
      }),
    )
    const dup = db
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM autonomous_goals WHERE description = ?`,
      )
      .get(landed[0].description)
    expect(dup?.n).toBe(1)
  })
})

describe('runPetEvolve — 日记', () => {
  it('20 点前不写（今天的后半天还没发生）', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    const writeDiary = vi.fn(async () => '今天')
    const result = await runPetEvolve(
      makeDeps(db, { writeDiary, now: () => new Date(2026, 8, 20, 14, 0, 0) }),
    )
    expect(result).toContain('diary: too-early')
    expect(writeDiary).not.toHaveBeenCalled()
  })

  it('★ 一天只写一篇（防重走 hasWrittenDiaryToday，按宠物分键）', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    const writeDiary = vi.fn(async () => '今天')
    await runPetEvolve(makeDeps(db, { writeDiary }))
    expect(writeDiary).toHaveBeenCalledTimes(1)

    // 再过一小时：日界守卫挡在反思之前，但日记那半仍要自己判一次
    await runPetEvolve(makeDeps(db, { writeDiary, now: () => new Date(2026, 8, 20, 22, 0, 0) }))
    expect(writeDiary).toHaveBeenCalledTimes(1)
  })

  it('写日记抛错不炸整轮（反思那两样已经落库了）', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    const result = await runPetEvolve(
      makeDeps(db, {
        writeDiary: async () => {
          throw new Error('endpoint 500')
        },
      }),
    )
    expect(result).toContain('diary: failed')
    expect(result).toContain('reflect:')
  })
})

describe('runPetEvolve — 失败与容错', () => {
  it('LLM 抛错不炸调用方（反思是旁路）', async () => {
    const db = createMigratedDb()
    seedEnoughWorks(db)
    const result = await runPetEvolve(
      makeDeps(db, {
        callLLM: async () => {
          throw new Error('endpoint 500')
        },
      }),
    )
    expect(result).toContain('cold-start') // 解析失败按"没反思出什么"处理
  })

  it('命令注册：__pet_evolve__ 被 companion 拦截（否则会被当成真实 prompt 喂给某个 Agent）', () => {
    expect(isLocalCompanionInstruction(PET_EVOLVE_INSTRUCTION)).toBe(true)
  })
})
