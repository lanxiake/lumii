/**
 * `tool_exposure_log` 的写入与清理。
 *
 * 这一层的全部意义是**让裁剪可证伪**：仓库此前只记「工具被调用」，
 * 从不记「工具被展示」，于是「没用」与「没机会用」分不开。
 *
 * 三条设计取舍记在 `schema.ts` 的 V56 注释里（一轮一行、tools 带 token、reason 列）。
 * 断言一律**直接读库**而不是经由读接口：生产里没有那个读接口（读的人是我们跑脚本），
 * 用自己写的读接口验证自己写的写入器，等于两边一起错也发现不了。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { createMigratedTestDb } from '../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import {
  EXPOSURE_RETENTION_DAYS,
  __resetToolExposureStoreForTest,
  initToolExposureStore,
  pruneToolExposure,
  recordToolExposure,
} from './tool-exposure-store'

type Db = ReturnType<typeof createMigratedTestDb>

interface Row {
  created_at: number
  session_key: string
  turn_id: string | null
  agent_id: string
  channel: string
  tool_count: number
  total_tokens: number
  tools: string
  reason: string
}

function rows(db: Db): Row[] {
  return db
    .prepare<Row>(
      `SELECT created_at, session_key, turn_id, agent_id, channel, tool_count, total_tokens, tools, reason
       FROM tool_exposure_log ORDER BY id`,
    )
    .all()
}

beforeEach(() => {
  __resetToolExposureStoreForTest()
})

describe('tool-exposure-store', () => {
  it('写入一行：字段与工具数组、token 合计都对得上', () => {
    const db = createMigratedTestDb()
    initToolExposureStore(db)

    recordToolExposure({
      sessionKey: 'cron:chronicler:daily',
      turnId: 'msg-1',
      agentId: 'chronicler',
      channel: 'cron',
      tools: [
        { n: 'bash', t: 320 },
        { n: 'file_read', t: 210 },
      ],
    })

    const [row] = rows(db)
    expect(row).toMatchObject({
      session_key: 'cron:chronicler:daily',
      turn_id: 'msg-1',
      agent_id: 'chronicler',
      channel: 'cron',
      tool_count: 2,
      total_tokens: 530,
      reason: 'turn',
    })
    expect(JSON.parse(row!.tools)).toEqual([
      { n: 'bash', t: 320 },
      { n: 'file_read', t: 210 },
    ])
    db.close()
  })

  it('turnId 缺失时留 NULL，不编造一个', () => {
    const db = createMigratedTestDb()
    initToolExposureStore(db)

    recordToolExposure({
      sessionKey: 'ipc:default',
      agentId: 'assistant',
      channel: 'ipc',
      tools: [{ n: 'bash', t: 1 }],
    })

    expect(rows(db)[0]?.turn_id).toBeNull()
    db.close()
  })

  it('空工具集也记一行（「一个都没暴露」本身是信息）', () => {
    const db = createMigratedTestDb()
    initToolExposureStore(db)

    recordToolExposure({ sessionKey: 's', turnId: 'm', agentId: 'a', channel: 'ipc', tools: [] })

    const [row] = rows(db)
    expect(row).toMatchObject({ tool_count: 0, total_tokens: 0 })
    expect(JSON.parse(row!.tools)).toEqual([])
    db.close()
  })

  it('reason 默认 turn，可显式写 search', () => {
    const db = createMigratedTestDb()
    initToolExposureStore(db)
    const base = { sessionKey: 's', turnId: 'm', agentId: 'a', channel: 'ipc', tools: [] as const }

    recordToolExposure(base)
    recordToolExposure({ ...base, reason: 'search' })

    expect(rows(db).map((r) => r.reason)).toEqual(['turn', 'search'])
    db.close()
  })

  it('多轮之间互不覆盖：每次调用都是一行新记录', () => {
    const db = createMigratedTestDb()
    initToolExposureStore(db)
    const base = { sessionKey: 's', agentId: 'a', channel: 'ipc', tools: [{ n: 'bash', t: 1 }] as const }

    recordToolExposure({ ...base, turnId: 'm1' })
    recordToolExposure({ ...base, turnId: 'm2' })

    expect(rows(db).map((r) => r.turn_id)).toEqual(['m1', 'm2'])
    db.close()
  })

  it('清理只删超过保留期的行', () => {
    const db = createMigratedTestDb()
    initToolExposureStore(db)

    const dayMs = 24 * 60 * 60 * 1000
    const now = Date.now()
    const ins = db.prepare(
      `INSERT INTO tool_exposure_log (created_at, session_key, turn_id, agent_id, channel, tool_count, total_tokens, tools, reason)
       VALUES (?, ?, NULL, 'a', 'ipc', 0, 0, '[]', 'turn')`,
    )
    ins.run(now - (EXPOSURE_RETENTION_DAYS + 1) * dayMs, 'old')
    ins.run(now - dayMs, 'recent')

    expect(pruneToolExposure(now)).toBe(1)
    expect(rows(db).map((r) => r.session_key)).toEqual(['recent'])
    db.close()
  })

  it('未注入库时静默不写也不抛（统计失败不影响对话）', () => {
    expect(() =>
      recordToolExposure({ sessionKey: 's', agentId: 'a', channel: 'ipc', tools: [] }),
    ).not.toThrow()
    expect(pruneToolExposure()).toBe(0)
  })

  it('表不存在时写入也不抛（迁移没跑过的老库）', () => {
    const db = createMigratedTestDb()
    db.exec('DROP TABLE tool_exposure_log')
    initToolExposureStore(db)

    expect(() =>
      recordToolExposure({ sessionKey: 's', agentId: 'a', channel: 'ipc', tools: [] }),
    ).not.toThrow()
    db.close()
  })
})
