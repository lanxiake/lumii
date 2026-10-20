import { beforeEach, describe, expect, it } from 'vitest'

import type { DatabaseAdapter, PetGoalSignal } from '@mtbot/agent-runtime'
import { createTestSqliteAdapter } from '../../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import { MIGRATIONS } from '../../../../../../packages/agent-runtime/src/storage/schema'
import { reportPetGoalReceipt, type PetGoalReceiptDeps } from './pet-goal-receipt'

/**
 * 回执的三件事各自独立：会话消息 / 气泡事件 / 持久回执。
 * 这里钉的是「一条挂了另外两条照发」——三期就是漏了事件这条，用户侧零回执。
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
  return db
}

function readReceipt(db: DatabaseAdapter): { ok: boolean; text: string } | undefined {
  const row = db
    .prepare<{ metadata: string | null }>('SELECT metadata FROM autonomous_goals WHERE id = ?')
    .get(GOAL.id)
  if (!row?.metadata) return undefined
  return (JSON.parse(row.metadata) as { result?: { ok: boolean; text: string } }).result
}

interface Calls {
  messages: Array<{ role: string; text: string; conversationId: string }>
  events: Array<{ goalId: string; ok: boolean; text: string; sessionKey: string }>
  ensured: string[]
}

function makeDeps(
  db: DatabaseAdapter,
  overrides: Partial<PetGoalReceiptDeps> = {},
): { deps: PetGoalReceiptDeps; calls: Calls } {
  const calls: Calls = { messages: [], events: [], ensured: [] }
  const deps: PetGoalReceiptDeps = {
    db,
    conversationIdFor: () => CONV,
    ensureConversation: (agentId, convId) => calls.ensured.push(`${agentId}/${convId}`),
    saveMessage: (m) =>
      calls.messages.push({
        role: m.role,
        text: m.contentJson.text,
        conversationId: m.conversationId,
      }),
    forwardEvent: (p) =>
      calls.events.push({ goalId: p.goalId, ok: p.ok, text: p.text, sessionKey: p.sessionKey }),
    ...overrides,
  }
  return { deps, calls }
}

describe.skipIf(!hasSqlite)('reportPetGoalReceipt', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
  })

  it('先补建会话，再写两条消息 + 推事件 + 落持久回执', () => {
    const { deps, calls } = makeDeps(db)

    reportPetGoalReceipt(GOAL, true, '办好了', { userTurn: GOAL.description }, deps)

    expect(calls.ensured).toEqual([`${AGENT}/${CONV}`])
    expect(calls.messages).toEqual([
      { role: 'user', text: GOAL.description, conversationId: CONV },
      { role: 'assistant', text: '办好了', conversationId: CONV },
    ])
    expect(calls.events).toEqual([
      { goalId: GOAL.id, ok: true, text: '办好了', sessionKey: CONV },
    ])
    expect(readReceipt(db)).toMatchObject({ ok: true, text: '办好了' })
  })

  it('不给 userTurn 时只写回执那一条', () => {
    const { deps, calls } = makeDeps(db)

    reportPetGoalReceipt(GOAL, false, '没做成', {}, deps)

    expect(calls.messages).toHaveLength(1)
    expect(calls.messages[0]).toMatchObject({ role: 'assistant', text: '没做成' })
  })

  it('空正文落库时写「（没有产出）」，事件里仍是原文', () => {
    const { deps, calls } = makeDeps(db)

    reportPetGoalReceipt(GOAL, false, '', {}, deps)

    expect(calls.messages[0].text).toBe('（没有产出）')
    expect(calls.events[0].text).toBe('')
  })

  it('会话写库抛错：事件照发、持久回执照落（三条互不牵连）', () => {
    const { deps, calls } = makeDeps(db, {
      saveMessage: () => {
        throw new Error('库锁了')
      },
    })

    expect(() => reportPetGoalReceipt(GOAL, true, '办好了', {}, deps)).not.toThrow()

    expect(calls.events).toHaveLength(1)
    expect(readReceipt(db)).toMatchObject({ ok: true, text: '办好了' })
  })
})
