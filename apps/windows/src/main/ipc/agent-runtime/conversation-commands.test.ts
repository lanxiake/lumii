import { describe, expect, it, vi } from 'vitest'
import {
  handleConversationDelete,
  handleConversationTransferAgent,
  setConversationDependencies,
  resolveConversationChannel,
} from './conversation-commands'
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

describe('conversation:transfer-agent 切换 Agent = 转移当前会话', () => {
  const setDeps = () => {
    const sessionToInstance = new Map<string, string>([['c1', 'inst-1']])
    const untrackInstanceRuns = vi.fn()
    setConversationDependencies({ sessionToInstance, untrackInstanceRuns } as never)
    return { sessionToInstance, untrackInstanceRuns }
  }

  const makeBridge = () => ({
    destroy: vi.fn(),
    clearSessionPreferredModel: vi.fn(),
    hasStreamingMessages: vi.fn(() => false),
    runtimeStateRepo: { delete: vi.fn() },
    conversationRepo: {
      getConversation: vi.fn(() => ({ id: 'c1' })),
      getAgentParticipantId: vi.fn(() => 'default'),
      updateAgentParticipant: vi.fn(),
    },
  })

  it('拒绝转移自主进化会话', () => {
    expect(() =>
      handleConversationTransferAgent({} as never, {
        type: 'conversation:transfer-agent',
        sessionKey: EVOLUTION_CONVERSATION_ID,
      } as never),
    ).toThrow('拒绝转移自主进化会话')
  })

  it('转移成功：更新参与者、销毁旧实例并清 CLI 续接键', () => {
    const { sessionToInstance, untrackInstanceRuns } = setDeps()
    const bridge = makeBridge()

    const result = handleConversationTransferAgent(bridge as never, {
      type: 'conversation:transfer-agent',
      sessionKey: 'c1',
      agentId: 'code-dev',
    } as never)

    expect(result).toEqual({ ok: true })
    expect(bridge.conversationRepo.updateAgentParticipant).toHaveBeenCalledWith('c1', 'code-dev')
    expect(bridge.destroy).toHaveBeenCalledWith('inst-1')
    expect(untrackInstanceRuns).toHaveBeenCalledWith('inst-1')
    expect(sessionToInstance.has('c1')).toBe(false)
    expect(bridge.clearSessionPreferredModel).toHaveBeenCalledWith('c1')
    expect(bridge.runtimeStateRepo.delete).toHaveBeenCalledTimes(4)
  })

  it('省略 agentId 时转回系统默认（default）', () => {
    setDeps()
    const bridge = makeBridge()
    bridge.conversationRepo.getAgentParticipantId.mockReturnValue('code-dev' as never)

    handleConversationTransferAgent(bridge as never, {
      type: 'conversation:transfer-agent',
      sessionKey: 'c1',
    } as never)

    expect(bridge.conversationRepo.updateAgentParticipant).toHaveBeenCalledWith('c1', 'default')
  })

  it('同 Agent 转移为 no-op：不销毁实例、不写库', () => {
    const { sessionToInstance } = setDeps()
    const bridge = makeBridge()
    bridge.conversationRepo.getAgentParticipantId.mockReturnValue('code-dev' as never)

    const result = handleConversationTransferAgent(bridge as never, {
      type: 'conversation:transfer-agent',
      sessionKey: 'c1',
      agentId: 'code-dev',
    } as never)

    expect(result).toEqual({ ok: true })
    expect(bridge.destroy).not.toHaveBeenCalled()
    expect(bridge.conversationRepo.updateAgentParticipant).not.toHaveBeenCalled()
    expect(sessionToInstance.has('c1')).toBe(true)
  })

  it('拒绝转移定时任务会话', () => {
    expect(() =>
      handleConversationTransferAgent({} as never, {
        type: 'conversation:transfer-agent',
        sessionKey: 'cron:news-pipeline',
        agentId: 'code-dev',
      } as never),
    ).toThrow('定时任务会话')
  })

  it("'default' 与 'assistant' 是同一系统默认 Agent（no-op，不销毁实例）", () => {
    const { sessionToInstance } = setDeps()
    const bridge = makeBridge() // getAgentParticipantId 默认返回 'default'

    const result = handleConversationTransferAgent(bridge as never, {
      type: 'conversation:transfer-agent',
      sessionKey: 'c1',
      agentId: 'assistant',
    } as never)

    expect(result).toEqual({ ok: true })
    expect(bridge.destroy).not.toHaveBeenCalled()
    expect(bridge.conversationRepo.updateAgentParticipant).not.toHaveBeenCalled()
    expect(sessionToInstance.has('c1')).toBe(true)
  })

  it('会话回复中拒绝转移', () => {
    setDeps()
    const bridge = makeBridge()
    bridge.hasStreamingMessages.mockReturnValue(true as never)

    expect(() =>
      handleConversationTransferAgent(bridge as never, {
        type: 'conversation:transfer-agent',
        sessionKey: 'c1',
        agentId: 'code-dev',
      } as never),
    ).toThrow('会话正在回复中')
  })

  it('会话不存在时抛 not_found', () => {
    setDeps()
    const bridge = makeBridge()
    bridge.conversationRepo.getConversation.mockReturnValue(undefined as never)

    expect(() =>
      handleConversationTransferAgent(bridge as never, {
        type: 'conversation:transfer-agent',
        sessionKey: 'missing',
        agentId: 'code-dev',
      } as never),
    ).toThrow('not_found')
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
