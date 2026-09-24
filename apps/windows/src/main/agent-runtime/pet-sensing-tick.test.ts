/**
 * 宠物感知循环的测试。
 *
 * 循环体薄（读信号 → 决策 → 落三件副作用），所以这里守的是**副作用只在该发生的时候发生**：
 * 门闩顺序、配额、以及"同一条低分只让它低落一次"。
 * 判错不会报错，只会表现成"它不理我"或者"它唠叨个没完"，两种都要连着几天才看得出来。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../packages/agent-runtime/src/storage/schema'
import { createTestSqliteAdapter } from '../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import { isLocalCompanionInstruction } from './local-companion-handler'
import {
  PET_SENSING_INSTRUCTION,
  ensurePetSensingCronJobSeeded,
  runPetSensing,
  type PetSensingDeps,
  type PetSensingPush,
} from './pet-sensing-tick'

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

const NOW = new Date('2026-09-24T12:00:00.000Z')
const PET = 'pet:demo_cartoon_cat'
const MIN = 60_000
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()

function insertConversation(db: DatabaseAdapter, id: string, title: string | null = null): void {
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at, last_msg_at)
     VALUES (?, 'local-user', 'direct', ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = COALESCE(excluded.title, conversations.title)`,
  ).run(id, title, at(60 * MIN), at(MIN))
}

function insertMessage(db: DatabaseAdapter, conversationId: string, msAgo: number): void {
  insertConversation(db, conversationId)
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content_json, timestamp)
     VALUES (?, ?, 'user', '{"type":"text","text":"x"}', ?)`,
  ).run(`m-${conversationId}-${msAgo}`, conversationId, at(msAgo))
}

/** 造一条连续工作链：每步小于空闲阈值，否则链会中途断掉 */
function insertChain(db: DatabaseAdapter, conversationId: string, totalMin: number): void {
  for (let m = totalMin; m >= 1; m -= 5) insertMessage(db, conversationId, m * MIN)
}

function insertInterruptions(db: DatabaseAdapter, conversationId: string, count: number): void {
  const value = JSON.stringify(
    Array.from({ length: count }, (_, i) => ({ k: 'abort', at: NOW.getTime() - (i + 1) * MIN })),
  )
  db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
    `feedback-log:${conversationId}`,
    value,
    at(0),
  )
}

function insertScore(db: DatabaseAdapter, id: string, score: number, msAgo = 2 * MIN): void {
  db.prepare(
    `INSERT INTO autonomous_satisfaction_scores
     (id, session_id, agent_id, task_completion, user_feedback, efficiency, knowledge_growth, overall_score, created_at)
     VALUES (?, 'conv-1', 'assistant', 0.5, 0.5, 0.5, 0.5, ?, ?)`,
  ).run(id, score, at(msAgo))
}

function makeDeps(db: DatabaseAdapter, overrides: Partial<PetSensingDeps> = {}) {
  const recordMood = vi.fn((_agentId: string, _event: string) => {})
  const pushSensingEvent = vi.fn((_event: PetSensingPush) => {})
  return {
    deps: {
      getDb: () => db,
      getPetAgentId: () => PET,
      recordMood,
      pushSensingEvent,
      now: () => NOW,
      ...overrides,
    } satisfies PetSensingDeps,
    recordMood,
    pushSensingEvent,
  }
}

describe.skipIf(!hasFts5Db)('runPetSensing', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
  })

  it('退出清场中直接跳过，不碰库也不改 mood', () => {
    const { deps, recordMood } = makeDeps(db, { isShuttingDown: () => true })
    expect(runPetSensing(deps)).toBe('skipped: shutting down')
    expect(recordMood).not.toHaveBeenCalled()
  })

  it('不在宠物模式就不做——没有宠物窗，说了也没人听见', () => {
    const { deps, recordMood, pushSensingEvent } = makeDeps(db, { getPetAgentId: () => null })
    expect(runPetSensing(deps)).toBe('skipped: not in pet mode')
    expect(recordMood).not.toHaveBeenCalled()
    expect(pushSensingEvent).not.toHaveBeenCalled()
  })

  it('手动执行时，拿不到宠物身份报得更具体（便于自测时定位）', () => {
    const { deps } = makeDeps(db, { getPetAgentId: () => null, manual: true })
    expect(runPetSensing(deps)).toBe('skipped: no-pet-agent')
  })

  it('**冷启动一条都不说**（验收：全新用户不硬说）', () => {
    insertInterruptions(db, 'conv-1', 5)
    insertChain(db, 'conv-1', 200)
    const { deps, pushSensingEvent } = makeDeps(db)
    expect(runPetSensing(deps)).toContain('cold-start')
    expect(pushSensingEvent).not.toHaveBeenCalled()
  })

  it('打断够次数 → 推一条气泡，并把配额记上', () => {
    insertScore(db, 's0', 0.9)
    insertInterruptions(db, 'conv-1', 3)
    insertChain(db, 'conv-1', 10)
    const { deps, pushSensingEvent } = makeDeps(db)

    expect(runPetSensing(deps)).toBe('spoke: interrupted')
    expect(pushSensingEvent).toHaveBeenCalledTimes(1)
    expect(pushSensingEvent.mock.calls[0][0]).toMatchObject({
      type: 'pet:sensing',
      sessionKey: 'conv-1',
      kind: 'interrupted',
    })
    // 配额落库了才挡得住下一拍
    expect(runPetSensing(deps)).not.toBe('spoke: interrupted')
    expect(pushSensingEvent).toHaveBeenCalledTimes(1)
  })

  it('低分会话 → 改宠物自己的 mood，**不说任何话**', () => {
    insertScore(db, 's-bad', 0.3)
    const { deps, recordMood, pushSensingEvent } = makeDeps(db)

    expect(runPetSensing(deps)).toContain('idle')
    expect(recordMood).toHaveBeenCalledWith(PET, 'user_struggling')
    // 验收："一句『我难过』都没说"——这条是那个断言的机械形态
    expect(pushSensingEvent).not.toHaveBeenCalled()
  })

  it('**同一条低分只让它低落一次**，下一拍照旧不重复', () => {
    insertScore(db, 's-bad', 0.3)
    const { deps, recordMood } = makeDeps(db)
    runPetSensing(deps)
    runPetSensing(deps)
    runPetSensing(deps)
    expect(recordMood).toHaveBeenCalledTimes(1)
  })

  it('新的低分（新 id）会再改一次——换个会话又不顺了，它当然会再蔫一点', () => {
    insertScore(db, 's-bad-1', 0.3, 4 * MIN)
    const { deps, recordMood } = makeDeps(db)
    runPetSensing(deps)
    insertScore(db, 's-bad-2', 0.2, 2 * MIN) // 更晚的一条
    runPetSensing(deps)
    expect(recordMood).toHaveBeenCalledTimes(2)
  })

  it('评分不低就不动 mood', () => {
    insertScore(db, 's-good', 0.9)
    const { deps, recordMood } = makeDeps(db)
    runPetSensing(deps)
    expect(recordMood).not.toHaveBeenCalled()
  })

  it('推事件抛错不炸穿调度层，返回可读的 error 串', () => {
    // 真实形态是 IPC 那头炸了（窗口正好被销毁之类）。**不是**关库——
    // 读路径每一步都自带 try-catch（`pet-sensing.ts` 的那些 `catch {}`），
    // 关库只会让信号全空、走到 cold-start，不会抛
    const pushSensingEvent = vi.fn(() => {
      throw new Error('IPC 通道已销毁')
    })
    insertScore(db, 's0', 0.9)
    insertInterruptions(db, 'conv-1', 3)
    insertChain(db, 'conv-1', 10)
    const { deps } = makeDeps(db, { pushSensingEvent })
    expect(runPetSensing(deps)).toBe('error: IPC 通道已销毁')
  })
})

describe.skipIf(!hasFts5Db)('ensurePetSensingCronJobSeeded', () => {
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
    ensurePetSensingCronJobSeeded(db)
    const job = readJob('pet-sensing')
    expect(job).toBeDefined()
    expect(job?.task_text).toBe(PET_SENSING_INSTRUCTION)
    // agent_id 必须为 NULL：非空的话 cron 会把它当真实 prompt 喂给某个 Agent
    expect(job?.agent_id).toBeNull()
    expect(job?.schedule_type).toBe('every')
    expect(job?.interval_ms).toBeGreaterThan(0)
    expect(job?.enabled).toBe(1)
  })

  it('指令串与 companion 的拦截集合一致（两处字面量不许漂移）', () => {
    expect(isLocalCompanionInstruction(PET_SENSING_INSTRUCTION)).toBe(true)
  })

  it('重复播种不产生第二条', () => {
    ensurePetSensingCronJobSeeded(db)
    ensurePetSensingCronJobSeeded(db)
    const row = db
      .prepare<{ count: number }>(`SELECT COUNT(*) as count FROM local_cron_jobs WHERE id = 'pet-sensing'`)
      .get()
    expect(row?.count).toBe(1)
  })

  it('形态自愈，但**不覆盖用户改过的 enabled**', () => {
    ensurePetSensingCronJobSeeded(db)
    db.prepare(
      `UPDATE local_cron_jobs SET enabled = 0, agent_id = 'assistant', schedule_type = 'cron' WHERE id = 'pet-sensing'`,
    ).run()

    ensurePetSensingCronJobSeeded(db)

    const job = readJob('pet-sensing')
    expect(job?.agent_id).toBeNull()
    expect(job?.schedule_type).toBe('every')
    expect(job?.enabled).toBe(0)
  })
})

/**
 * 与三期 T3.5 同形的守卫：**感知也不许走系统通知**（设计 §4.1.5 第 3 条「只走气泡」）。
 *
 * 为什么值得单独立一条：`handleEvolutionTick` 那条路是发系统通知的，照抄它的装配
 * 就会让"该歇会儿了"同时弹一个桌面弹窗。这个错误不报错、单测也照过，
 * 只有用户会觉得"这宠物怎么还弹窗"。
 */
describe('P3 守卫：感知的播报通道只有气泡', () => {
  function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  }

  it('pet-sensing-tick.ts 一次都没提系统通知', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pet-sensing-tick.ts')
    const code = stripComments(readFileSync(file, 'utf8'))

    // 剥注释不能把代码也剥没了（正则写坏时这条会红）
    expect(code).toContain('runPetSensing')
    expect(code).not.toContain('showCronNotification')
    expect(code).not.toContain('dispatchNotifications')
    expect(code).not.toContain('triggerCronNotification')
  })

  it('对照组：bridge.ts 里确实有系统通知——所以上面那条不是空断言', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge.ts')
    const source = readFileSync(file, 'utf8')
    expect(source).toMatch(/showCronNotification/)
  })
})
