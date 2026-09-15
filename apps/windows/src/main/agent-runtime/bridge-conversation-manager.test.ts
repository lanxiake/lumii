/**
 * 会话归属写入（10-S2）：建会话时把 `channel_type` 落库。
 *
 * 规则：adapter 传的 channelType 优先（创建那一刻它就是权威）；未传时按 id 前缀推断
 * （存量调用点与系统会话的安全网）。归属 = 会话从哪来，与「此刻谁在说话」无关。
 */

import { describe, expect, it, vi } from 'vitest'
import { BridgeConversationManager } from './bridge-conversation-manager'

interface InsertCall {
  sql: string
  params: readonly unknown[]
}

function makeManager(opts: { existing?: boolean } = {}) {
  const inserts: InsertCall[] = []
  const db = {
    prepare: vi.fn((sql: string) => ({
      run: vi.fn((...params: unknown[]) => {
        inserts.push({ sql, params })
        return { changes: 1, lastInsertRowid: 1 }
      }),
    })),
  }
  const deps = {
    getConversationRepo: () => ({
      getConversation: () => (opts.existing ? { id: 'x' } : undefined),
    }),
    localDb: { db },
  }
  const manager = new BridgeConversationManager(deps as never)
  return { manager, inserts }
}

const convInsert = (inserts: readonly InsertCall[]) =>
  inserts.find((i) => i.sql.includes('INSERT OR IGNORE INTO conversations'))

describe('ensureConversationExists · 归属落库', () => {
  it('显式传入 channelType 时按传入值写（adapter 的权威信号）', () => {
    const { manager, inserts } = makeManager()
    manager.ensureConversationExists('qbot:964A', 'QQ - 964A', 'qbot')

    const call = convInsert(inserts)
    expect(call?.sql).toContain('channel_type')
    expect(call?.params.at(-1)).toBe('qbot')
  })

  it('未传 channelType 时按 id 前缀推断', () => {
    const { manager, inserts } = makeManager()
    manager.ensureConversationExists('weixin:u1', '微信对话 - u1')

    expect(convInsert(inserts)?.params.at(-1)).toBe('weixin')
  })

  it('未传且无已知前缀（客户端会话）→ ipc', () => {
    const { manager, inserts } = makeManager()
    manager.ensureConversationExists('1f3c9a2b', '新对话')

    expect(convInsert(inserts)?.params.at(-1)).toBe('ipc')
  })

  it('传入值非法时回退前缀，不写脏值', () => {
    const { manager, inserts } = makeManager()
    manager.ensureConversationExists('cron:job-1', '定时任务', 'telegram')

    expect(convInsert(inserts)?.params.at(-1)).toBe('cron')
  })

  it('会话已存在时不写（保证既有归属不被覆盖）', () => {
    const { manager, inserts } = makeManager({ existing: true })
    manager.ensureConversationExists('qbot:964A', 'QQ - 964A', 'weixin')

    expect(convInsert(inserts)).toBeUndefined()
  })
})

describe('listRecentConversations · 带出归属', () => {
  it('把落库的 channel_type 透传给调用方（缺失为 null，由消费方回退前缀）', () => {
    const manager = new BridgeConversationManager({
      getConversationRepo: () => ({
        listActiveConversations: () => [
          { id: 'qbot:964A', title: 'QQ 会话', last_msg_at: null, created_at: 'T', channel_type: 'qbot' },
          { id: 'abc123', title: '客户端会话', last_msg_at: null, created_at: 'T' },
        ],
      }),
      localDb: { db: { prepare: vi.fn() } },
    } as never)

    expect(manager.listRecentConversations(10)).toEqual([
      { id: 'qbot:964A', title: 'QQ 会话', updatedAt: 'T', channelType: 'qbot' },
      { id: 'abc123', title: '客户端会话', updatedAt: 'T', channelType: null },
    ])
  })
})
