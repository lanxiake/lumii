/**
 * 反馈信号的两份存储（第四期 T4.2 补的第二条）。
 *
 * 两份的**生命周期不同**，而它们写在同一处、读在不同处——这一层没有类型能表达
 * "这份会被清零、那份不会"，所以只能靠用例钉住：
 *
 * | 键 | 谁消费 | 消费后 |
 * |---|---|---|
 * | `feedback:{会话}` | 满意度评分（`onTurnEnd`） | **清零** |
 * | `feedback-log:{会话}` | 宠物感知（`pet-sensing.ts`） | **不清** |
 *
 * 判错的形态是静默的：流水被一起清掉，规则①（打断 ≥3 次靠近陪着）就**永远不触发**，
 * 日志里只会看到 `interruptions=0/3`，看起来跟"用户今天很顺"一模一样。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../packages/agent-runtime/src/storage/schema'
import { createTestSqliteAdapter } from '../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import {
  deriveUserFeedback,
  readCounters,
  recordAbort,
  recordEdit,
  recordResend,
  resetCounters,
} from './autonomous-feedback-signals'

const CONV = 'conv-1'

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

const readLog = (db: DatabaseAdapter, conversationId = CONV): Array<{ k: string; at: number }> => {
  const row = db
    .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
    .get(`feedback-log:${conversationId}`)
  return row?.value ? (JSON.parse(row.value) as Array<{ k: string; at: number }>) : []
}

describe.skipIf(!hasFts5Db)('反馈信号', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
  })

  it('三类信号都同时进计数与流水', () => {
    recordAbort(db, CONV)
    recordResend(db, CONV)
    recordEdit(db, CONV)

    expect(readCounters(db, CONV)).toEqual({ aborts: 1, resends: 1, edits: 1 })
    expect(readLog(db).map((e) => e.k)).toEqual(['aborts', 'resends', 'edits'])
  })

  it('流水带时间戳——感知按窗口数个数，不认累计值', () => {
    const before = Date.now()
    recordAbort(db, CONV)
    const after = Date.now()
    const at = readLog(db)[0].at
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(after)
  })

  it('**评分消费计数，但不碰流水**（第四期 T4.2 的全部要点）', () => {
    recordAbort(db, CONV)
    recordAbort(db, CONV)
    recordAbort(db, CONV)

    resetCounters(db, CONV)

    // 计数清零：一次编辑不该永久拉低后续每一轮
    expect(readCounters(db, CONV)).toEqual({ aborts: 0, resends: 0, edits: 0 })
    // 流水还在：感知要回答的是"最近半小时被打断了几次"，被消费掉就没法回答了
    expect(readLog(db)).toHaveLength(3)
  })

  it('不清零的话计数会一直堆着——这正是它到不了 3 的原因（留着当反面参照）', () => {
    const db2 = createMigratedDb()
    recordAbort(db2, CONV)
    resetCounters(db2, CONV)
    recordAbort(db2, CONV)
    // 计数永远是 1：打断一次 → 这一轮结束 → 归零 → 再打断又是 1
    expect(readCounters(db2, CONV).aborts).toBe(1)
    // 而流水是 2 —— 感知读的是这个
    expect(readLog(db2)).toHaveLength(2)
  })

  it('流水条数有上限，不会把 runtime_state 撑大', () => {
    for (let i = 0; i < 60; i += 1) recordAbort(db, CONV)
    expect(readLog(db).length).toBeLessThanOrEqual(50)
    // 只留最近的：越界的是最早那些
    const times = readLog(db).map((e) => e.at)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('流水读坏了不影响计数，也不抛', () => {
    db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, '不是 JSON', '')`).run(
      `feedback-log:${CONV}`,
    )
    expect(() => recordAbort(db, CONV)).not.toThrow()
    expect(readCounters(db, CONV).aborts).toBe(1)
    expect(readLog(db)).toHaveLength(1)
  })

  it('按会话分开存——两条会话的打断不会互相算数', () => {
    recordAbort(db, 'conv-a')
    recordAbort(db, 'conv-b')
    expect(readLog(db, 'conv-a')).toHaveLength(1)
    expect(readLog(db, 'conv-b')).toHaveLength(1)
  })

  it('deriveUserFeedback 的口径没变（宠物感知不参与打分）', () => {
    expect(deriveUserFeedback({ aborts: 0, resends: 0, edits: 0 })).toBe(0.85)
    expect(deriveUserFeedback({ aborts: 1, resends: 0, edits: 0 })).toBeCloseTo(0.6)
  })
})
