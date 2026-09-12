import { describe, expect, it, vi } from 'vitest'
import { handleConversationDelete, setConversationDependencies, resolveConversationChannel } from './conversation-commands'
import { EVOLUTION_CONVERSATION_ID, isEvolutionConversationId } from '@mtbot/agent-runtime'

describe('conversation:delete 自主进化会话守卫', () => {
  it('拒绝删除自主进化专属会话', () => {
    expect(() =>
      handleConversationDelete({} as never, {
        type: 'conversation:delete',
        sessionKey: EVOLUTION_CONVERSATION_ID,
      } as never),
    ).toThrow('拒绝删除自主进化会话')
  })

  it('多 Agent 自主会话同样拒绝删除（evolution:<agentId>）', () => {
    expect(() =>
      handleConversationDelete({} as never, {
        type: 'conversation:delete',
        sessionKey: 'evolution:code-dev',
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

describe('resolveConversationChannel 会话来源推导', () => {
  const emptyWeixin = new Set<string>()

  it('cron:<jobId> → cron', () => {
    expect(resolveConversationChannel('cron:news-pipeline', emptyWeixin)).toBe('cron')
  })

  it('evolution:main → evolution', () => {
    expect(resolveConversationChannel(EVOLUTION_CONVERSATION_ID, emptyWeixin)).toBe('evolution')
  })

  it('evolution:<agentId> → evolution（多 Agent 自主会话）', () => {
    expect(resolveConversationChannel('evolution:code-dev', emptyWeixin)).toBe('evolution')
  })

  it('本地新建 → default', () => {
    expect(resolveConversationChannel('conversation-1', emptyWeixin)).toBe('default')
  })

  it('weixin: 前缀 → wechat', () => {
    expect(resolveConversationChannel('weixin:user1', emptyWeixin)).toBe('wechat')
  })

  it('微信绑定会话 → wechat（不依赖前缀）', () => {
    const weixin = new Set(['bound-conv-1'])
    expect(resolveConversationChannel('bound-conv-1', weixin)).toBe('wechat')
  })

  it('wecom:/feishu: 前缀 → 对应渠道', () => {
    expect(resolveConversationChannel('wecom:u1', emptyWeixin)).toBe('wecom')
    expect(resolveConversationChannel('feishu:ou_1', emptyWeixin)).toBe('feishu')
  })
})

describe('isEvolutionConversationId 前缀判定', () => {
  it('覆盖 evolution:main 与 evolution:<agentId>，不误伤普通会话', () => {
    expect(isEvolutionConversationId(EVOLUTION_CONVERSATION_ID)).toBe(true)
    expect(isEvolutionConversationId('evolution:code-dev')).toBe(true)
    expect(isEvolutionConversationId('evolutionary:x')).toBe(false)
    expect(isEvolutionConversationId('conversation-1')).toBe(false)
  })
})
