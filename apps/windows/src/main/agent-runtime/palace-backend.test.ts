/**
 * 记忆宫殿的宿主侧接线（自建 SQLite）
 *
 * 动因（评审 2026-09-17 §4.6）：宫殿原由 MemPalace（Python + chromadb）承载，
 * 本机 chromadb 的 Rust 内核 upsert 直接 0xC0000005 崩溃 → 段原文一条也归档不进去，
 * `palace_drawer_id` 覆盖率实测 4/171 = 2.3%。换实现之后要守住的是：
 *
 * 1. 默认走自建，且**真的**把段原文写进 `palace_drawers`、能检索回来
 * 2. 数据库未打开时降级为「不可用」而不是抛异常——宫殿坏了不该让整轮对话失败
 */
import { describe, expect, it, vi } from 'vitest'
import { withBuiltinPalace } from './palace-backend'
import type { AgentRuntimeBridgeConfig } from './bridge-types'
import type { LocalDatabase } from '@mtbot/agent-runtime'
import { createMigratedTestDb } from '../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'

/** 只用到 isOpen / db 两个成员；用真实 LocalDatabase 会触发一遍迁移，没必要 */
function fakeLocalDb(db: unknown, isOpen = true): LocalDatabase {
  return { isOpen, db } as unknown as LocalDatabase
}

const emptyConfig = {} as AgentRuntimeBridgeConfig

describe('withBuiltinPalace', () => {
  it('归档 → 检索 → 读回闭环，且 drawer_id 由内容寻址给出', async () => {
    const db = createMigratedTestDb()
    const config = withBuiltinPalace(emptyConfig, fakeLocalDb(db))

    const archived = await config.archivePalaceDrawer!({
      content: '这段对话在排查工单同步的卡点：队列积压、消费端超时。',
      wing: 'assistant:local-user',
      room: '2026-09-17',
      drawerId: 'ignored-by-builtin',
      agentId: 'assistant',
      userId: 'local-user',
      metadata: { source: 'segment', segmentId: 'seg-1', conversationId: 'conv-1' },
    })

    expect(archived?.drawerId).toMatch(/^[a-f0-9]{16}$/)
    const drawerId = archived!.drawerId as string

    const hits = await config.searchPalace!('工单同步', 10, { userId: 'local-user' })
    expect(hits).toHaveLength(1)
    expect(hits![0]!.drawer_id).toBe(drawerId)
    expect(hits![0]!.text).toContain('工单同步')
    expect(hits![0]!.score).toBeGreaterThan(0) // -bm25：越大越相关

    const detail = await config.readPalaceDrawer!(drawerId)
    expect(detail?.content).toContain('消费端超时')
    expect(detail?.metadata?.segmentId).toBe('seg-1')
    expect(detail?.metadata?.conversationId).toBe('conv-1')
  })

  it('同一段重复归档幂等：仍只有一条，检索也只出一条', async () => {
    const db = createMigratedTestDb()
    const config = withBuiltinPalace(emptyConfig, fakeLocalDb(db))
    const params = {
      content: '同一段原文归档两次。',
      wing: 'w',
      room: 'r',
      drawerId: 'x'.repeat(16),
      agentId: 'assistant',
      userId: 'local-user',
    }

    const a = await config.archivePalaceDrawer!(params)
    const b = await config.archivePalaceDrawer!(params)
    expect(b?.drawerId).toBe(a?.drawerId)

    const rows = db
      .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM palace_drawers')
      .get()!.c
    expect(rows).toBe(1)
    expect(await config.searchPalace!('归档两次', 10, { userId: 'local-user' })).toHaveLength(1)
  })

  it('作用域：agentId 缺省跨 Agent，传了就收窄（与工作记忆通道同规则）', async () => {
    const db = createMigratedTestDb()
    const config = withBuiltinPalace(emptyConfig, fakeLocalDb(db))
    // wing 按线上默认写法带上 agent 作用域：内容寻址是 (wing, room, content)，
    // 作用域只有靠 wing 才能进到 id 里（见 PalaceRepo 的说明）
    const base = { room: 'r', drawerId: 'y'.repeat(16), content: '雪山行程的讨论。' }

    await config.archivePalaceDrawer!({
      ...base,
      wing: 'agent-a:local-user',
      agentId: 'agent-a',
      userId: 'local-user',
    })
    await config.archivePalaceDrawer!({
      ...base,
      wing: 'agent-b:local-user',
      agentId: 'agent-b',
      userId: 'local-user',
    })

    expect(await config.searchPalace!('雪山', 10, { userId: 'local-user' })).toHaveLength(2)
    expect(
      await config.searchPalace!('雪山', 10, { userId: 'local-user', agentId: 'agent-a' }),
    ).toHaveLength(1)
    // 别的用户搜不到（命名空间隔离）
    expect(await config.searchPalace!('雪山', 10, { userId: 'someone-else' })).toHaveLength(0)
  })

  it('数据库未打开时降级：检索返回 null、读取返回 null、归档返回 undefined，且不抛异常', async () => {
    const db = createMigratedTestDb()
    const config = withBuiltinPalace(emptyConfig, fakeLocalDb(db, false))

    await expect(config.searchPalace!('任意', 10, { userId: 'local-user' })).resolves.toBeNull()
    await expect(config.readPalaceDrawer!('a'.repeat(16))).resolves.toBeNull()
    await expect(
      config.archivePalaceDrawer!({
        content: 'x',
        wing: 'w',
        room: 'r',
        drawerId: 'a'.repeat(16),
      }),
    ).resolves.toBeUndefined()
  })


  it('归档时缺 agentId/userId 也不写坏数据（有默认作用域）', async () => {
    const db = createMigratedTestDb()
    const config = withBuiltinPalace(emptyConfig, fakeLocalDb(db))

    await config.archivePalaceDrawer!({
      content: '没带作用域的归档。',
      wing: 'w',
      room: 'r',
      drawerId: 'z'.repeat(16),
    })

    const row = db
      .prepare<{ agent_id: string; user_id: string }>(
        'SELECT agent_id, user_id FROM palace_drawers LIMIT 1',
      )
      .get()!
    expect(row.agent_id).toBe('assistant')
    expect(row.user_id).toBe('local-user')
  })

  it('段行不存在（或已被删）也归档得进去：存档不该被运维行约束', async () => {
    const db = createMigratedTestDb()
    const config = withBuiltinPalace(emptyConfig, fakeLocalDb(db))

    // 归档跑在异步总结队列里，用户完全可能在它落地前删掉会话
    await expect(
      config.archivePalaceDrawer!({
        content: '会话已经被删掉了，但这段原文还该留下来。',
        wing: 'assistant:local-user',
        room: '2026-09-17',
        drawerId: 'q'.repeat(16),
        agentId: 'assistant',
        userId: 'local-user',
        metadata: { source: 'segment', segmentId: 'seg-already-deleted', conversationId: 'conv-gone' },
      }),
    ).resolves.toMatchObject({ drawerId: expect.stringMatching(/^[a-f0-9]{16}$/) })

    expect(await config.searchPalace!('留下来', 10, { userId: 'local-user' })).toHaveLength(1)
  })
})

describe('onConversationEnd（每轮归档）', () => {
  /**
   * 造一个带会话 + 参与者 + 助手消息的最小库。
   *
   * 归属写进 `conversation_participants` 而**不是** `messages.agent_id`——后者在真实
   * 库里几乎全是 NULL（主聊天路径落库不写它），照它取会得到清一色的兜底 `assistant`。
   */
  function seedConversation(
    db: ReturnType<typeof createMigratedTestDb>,
    convId: string,
    agentId: string,
  ) {
    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, is_active, created_at, last_msg_at)
       VALUES (?, 'local-user', 'direct', 't', 1, '2026-09-18T00:00:00Z', '2026-09-18T00:00:00Z')`,
    ).run(convId)
    db.prepare(
      `INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, joined_at)
       VALUES (?, 'agent', ?, '2026-09-18T00:00:00Z')`,
    ).run(convId, agentId)
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content_json, timestamp, is_streaming)
       VALUES (?, ?, 'assistant', '{"type":"text","text":"x"}', '2026-09-18T00:00:01Z', 0)`,
    ).run(`m-${convId}`, convId)
  }

  it('每轮助手回复写进 builtin 宫殿，且能被检索命中', () => {
    const db = createMigratedTestDb()
    seedConversation(db, 'conv-1', 'assistant')
    const config = withBuiltinPalace(emptyConfig, fakeLocalDb(db))

    config.onConversationEnd!('conv-1', '这一轮在讨论雪山行程的住宿安排。')

    const row = db
      .prepare<{ wing: string; room: string; agent_id: string; user_id: string; conversation_id: string }>(
        'SELECT wing, room, agent_id, user_id, conversation_id FROM palace_drawers',
      )
      .get()!
    // wing/room 沿用旧宫殿的坐标，不重命名——旧 sqlite 里的历史内容用的就是这组，
    // 改名会让同内容出现两个 drawer_id
    expect(row.wing).toBe('conversations')
    expect(row.room).toBe('conv-1')
    expect(row.conversation_id).toBe('conv-1')
    expect(row.user_id).toBe('local-user')
    expect(row.agent_id).toBe('assistant')
  })

  it('先转发宿主原回调（自主进化的轮次结算还挂在上面）', () => {
    const db = createMigratedTestDb()
    seedConversation(db, 'conv-2', 'assistant')
    const forwarded: [string, string][] = []
    const config = withBuiltinPalace(
      {
        onConversationEnd: (c: string, t: string) => forwarded.push([c, t]),
      } as unknown as AgentRuntimeBridgeConfig,
      fakeLocalDb(db),
    )

    config.onConversationEnd!('conv-2', '宿主回调不能被整体替换掉。')

    expect(forwarded).toEqual([['conv-2', '宿主回调不能被整体替换掉。']])
  })

  it('宿主回调抛异常也不连累归档（内容仍要进宫殿）', () => {
    const db = createMigratedTestDb()
    seedConversation(db, 'conv-4', 'assistant')
    const config = withBuiltinPalace(
      {
        onConversationEnd: () => {
          throw new Error('宿主回调炸了')
        },
      } as unknown as AgentRuntimeBridgeConfig,
      fakeLocalDb(db),
    )

    expect(() => config.onConversationEnd!('conv-4', '回调炸了也要归档。')).not.toThrow()
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM palace_drawers').get()!.c).toBe(1)
  })

  it('DB 未打开 / 空文本 / 空 convId 时静默跳过，不抛异常', () => {
    const closed = withBuiltinPalace(emptyConfig, fakeLocalDb(createMigratedTestDb(), false))
    expect(() => closed.onConversationEnd!('conv-1', '有内容')).not.toThrow()

    const db = createMigratedTestDb()
    const open = withBuiltinPalace(emptyConfig, fakeLocalDb(db))
    expect(() => open.onConversationEnd!('conv-1', '   ')).not.toThrow()
    expect(() => open.onConversationEnd!('', '有内容')).not.toThrow()
    expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM palace_drawers').get()!.c).toBe(0)
  })

  it('归档归属取会话的 Agent，而不是写死 assistant', () => {
    const db = createMigratedTestDb()
    seedConversation(db, 'conv-3', 'code-dev')
    const config = withBuiltinPalace(emptyConfig, fakeLocalDb(db))

    config.onConversationEnd!('conv-3', '这段归 code-dev。')

    const row = db.prepare<{ agent_id: string }>('SELECT agent_id FROM palace_drawers').get()!
    expect(row.agent_id).toBe('code-dev')
  })

  it('参与者是实例 id（main/default）时归一化成定义 id，不写成 main', () => {
    // 真实库实测：178 个主会话的参与者是 'main'（实例 id），而宫殿/工作记忆用定义 id
    // （'assistant'）。照抄会让 memory_search 按 agent 过滤时一条都搜不到——比空值更糟。
    const db = createMigratedTestDb()
    seedConversation(db, 'conv-main', 'main')
    const config = withBuiltinPalace(emptyConfig, fakeLocalDb(db))

    config.onConversationEnd!('conv-main', '主会话的归档。')

    const row = db.prepare<{ agent_id: string }>('SELECT agent_id FROM palace_drawers').get()!
    expect(row.agent_id).toBe('assistant')
  })

  it('没有参与者记录时退到 messages.agent_id', () => {
    const db = createMigratedTestDb()
    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, is_active, created_at, last_msg_at)
       VALUES ('conv-6', 'local-user', 'direct', 't', 1, '2026-09-18T00:00:00Z', '2026-09-18T00:00:00Z')`,
    ).run()
    db.prepare(
      `INSERT INTO messages (id, conversation_id, agent_id, role, content_json, timestamp, is_streaming)
       VALUES ('m6', 'conv-6', 'code-dev', 'assistant', '{"type":"text","text":"x"}', '2026-09-18T00:00:01Z', 0)`,
    ).run()
    const config = withBuiltinPalace(emptyConfig, fakeLocalDb(db))

    config.onConversationEnd!('conv-6', '没有参与者但有消息归属。')

    const row = db.prepare<{ agent_id: string }>('SELECT agent_id FROM palace_drawers').get()!
    expect(row.agent_id).toBe('code-dev')
  })

  it('会话没有 agent 参与者时兜底 assistant（老会话/建会话竞态）', () => {
    const db = createMigratedTestDb()
    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, is_active, created_at, last_msg_at)
       VALUES ('conv-5', 'local-user', 'direct', 't', 1, '2026-09-18T00:00:00Z', '2026-09-18T00:00:00Z')`,
    ).run()
    const config = withBuiltinPalace(emptyConfig, fakeLocalDb(db))

    expect(() => config.onConversationEnd!('conv-5', '没有参与者的会话。')).not.toThrow()
    const row = db.prepare<{ agent_id: string }>('SELECT agent_id FROM palace_drawers').get()!
    expect(row.agent_id).toBe('assistant')
  })

})
