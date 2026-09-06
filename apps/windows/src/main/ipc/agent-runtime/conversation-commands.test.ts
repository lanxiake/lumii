import { describe, expect, it, vi } from 'vitest'
import { handleConversationDelete, setConversationDependencies } from './conversation-commands'
import { EVOLUTION_CONVERSATION_ID } from '@mtbot/agent-runtime'

describe('conversation:delete 自主进化会话守卫', () => {
  it('拒绝删除自主进化专属会话', () => {
    expect(() =>
      handleConversationDelete({} as never, {
        type: 'conversation:delete',
        sessionKey: EVOLUTION_CONVERSATION_ID,
      } as never),
    ).toThrow('拒绝删除自主进化会话')
  })

  it('允许删除普通会话（守卫不误伤）', () => {
    setConversationDependencies({
      sessionToInstance: new Map(),
      untrackInstanceRuns: vi.fn(),
    } as never)
    const deleteConversation = vi.fn()
    const bridge = {
      destroy: vi.fn(),
      clearSessionPreferredModel: vi.fn(),
      fileRepo: { listByConversation: vi.fn(() => []), softDelete: vi.fn() },
      conversationRepo: { deleteConversation },
    }

    expect(() =>
      handleConversationDelete(bridge as never, {
        type: 'conversation:delete',
        sessionKey: 'conversation-1',
      } as never),
    ).not.toThrow()
    expect(deleteConversation).toHaveBeenCalledWith('conversation-1')
  })
})
