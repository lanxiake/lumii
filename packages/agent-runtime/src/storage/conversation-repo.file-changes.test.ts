/**
 * ConversationRepo.listFileChangeTurns —— 版本历史的全量数据源。
 *
 * UI 只加载最近几十条消息，版本历史要覆盖整个会话，所以这条查询必须自己扫库。
 * 守的边界：只认 assistant 的 fileChanges、过滤 unattributed、同路径多版按时间升序、
 * 没有变更的回合不产生空条目。
 */
import { describe, expect, it } from 'vitest'
import { createMigratedTestDb } from '../__tests__/helpers/sqlite-test-db.js'
import { ConversationRepo } from './conversation-repo.js'

const USER = 'local-user'

function saveAssistant(
  repo: ConversationRepo,
  conversationId: string,
  id: string,
  timestamp: string,
  fileChanges?: unknown,
): void {
  repo.saveMessage({
    id,
    conversationId,
    role: 'assistant',
    contentJson: {
      type: 'assistant_parts',
      parts: [{ type: 'text', id: 'tx-1', text: 'done', status: 'done' }],
      ...(fileChanges ? { fileChanges } : {}),
    },
    timestamp,
  })
}

describe('ConversationRepo.listFileChangeTurns', () => {
  it('只返回带 fileChanges 的 assistant 回合，按时间升序', () => {
    const db = createMigratedTestDb()
    const repo = new ConversationRepo(db)
    const conversation = repo.createConversation({ userId: USER, participants: [] })

    saveAssistant(repo, conversation.id, 'a1', '2026-01-01T00:00:01.000Z', [
      { path: 'outputs/x/a.png', status: 'added' },
    ])
    saveAssistant(repo, conversation.id, 'a2', '2026-01-01T00:00:02.000Z')
    saveAssistant(repo, conversation.id, 'a3', '2026-01-01T00:00:03.000Z', [
      { path: 'outputs/x/a.png', status: 'modified' },
    ])
    repo.saveMessage({
      id: 'u1',
      conversationId: conversation.id,
      role: 'user',
      contentJson: { type: 'text', text: 'hi' },
      timestamp: '2026-01-01T00:00:04.000Z',
    })

    const turns = repo.listFileChangeTurns(conversation.id)
    expect(turns.map((t) => t.messageId)).toEqual(['a1', 'a3'])
    expect(turns[0]!.changes).toEqual([{ path: 'outputs/x/a.png', status: 'added' }])
    expect(turns[1]!.changes).toEqual([{ path: 'outputs/x/a.png', status: 'modified' }])
    db.close()
  })

  it('过滤 unattributed 与非法条目；全部被过滤时整轮不出现', () => {
    const db = createMigratedTestDb()
    const repo = new ConversationRepo(db)
    const conversation = repo.createConversation({ userId: USER, participants: [] })

    saveAssistant(repo, conversation.id, 'a1', '2026-01-01T00:00:01.000Z', [
      { path: 'uploads/x.png', status: 'modified', confidence: 'unattributed' },
      { path: '', status: 'added' },
      { path: 'outputs/ok.md', status: 'bogus' },
      { path: 'outputs/ok.md', status: 'added', confidence: 'exact' },
    ])
    saveAssistant(repo, conversation.id, 'a2', '2026-01-01T00:00:02.000Z', [
      { path: 'uploads/y.png', status: 'modified', confidence: 'unattributed' },
    ])

    const turns = repo.listFileChangeTurns(conversation.id)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.changes).toEqual([
      { path: 'outputs/ok.md', status: 'added', confidence: 'exact' },
    ])
    db.close()
  })

  it('别的会话的变更不会串进来', () => {
    const db = createMigratedTestDb()
    const repo = new ConversationRepo(db)
    const one = repo.createConversation({ userId: USER, participants: [] })
    const two = repo.createConversation({ userId: USER, participants: [] })
    saveAssistant(repo, one.id, 'a1', '2026-01-01T00:00:01.000Z', [
      { path: 'outputs/one.md', status: 'added' },
    ])
    saveAssistant(repo, two.id, 'b1', '2026-01-01T00:00:02.000Z', [
      { path: 'outputs/two.md', status: 'added' },
    ])

    expect(repo.listFileChangeTurns(one.id).map((t) => t.messageId)).toEqual(['a1'])
    expect(repo.listFileChangeTurns(two.id).map((t) => t.messageId)).toEqual(['b1'])
    db.close()
  })
})
