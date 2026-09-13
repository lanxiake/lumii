/**
 * send_message 传话落库（G4）：协作痕迹写入会话消息流，用户可见。
 */
import { describe, expect, it, vi } from 'vitest'
import { BridgeToolRegistrar, type BridgeToolRegistrarDeps } from './bridge-tool-registrar'

interface SavedMessageCall {
  conversationId: string
  agentId?: string
  role: string
  contentJson: {
    type: string
    parts: Array<{ type: string; text: string; status: string }>
  }
}

function makeRegistrar(overrides: { saveMessage?: (...args: unknown[]) => unknown } = {}) {
  const saveMessage = vi.fn(overrides.saveMessage ?? (() => ({ id: 'msg-1' })))
  const forwardIpcEvent = vi.fn()
  const deps = {
    getConversationRepo: () => ({ saveMessage }),
    instanceToConversation: new Map([['inst-a', 'conv-1']]),
    getDefinitionIdByInstanceId: (id: string) => (id === 'inst-a' ? 'assistant' : 'system-keeper'),
    ensureOrchestrator: () => ({
      getActiveAgents: () => [
        { agentId: 'inst-a', name: '灵栖', state: 'running' },
        { agentId: 'inst-b', name: '灵栖维护', state: 'idle' },
      ],
    }),
    ipcChannel: { forwardIpcEvent },
  } as unknown as BridgeToolRegistrarDeps
  const registrar = new BridgeToolRegistrar(deps)
  const record = (
    registrar as unknown as {
      recordAgentMessageDelivered: (from: string, to: string, message: string) => void
    }
  ).recordAgentMessageDelivered.bind(registrar)
  return {
    record,
    saveMessage,
    forwardIpcEvent,
    lastSaved: () => saveMessage.mock.calls[0]?.[0] as unknown as SavedMessageCall,
  }
}

describe('recordAgentMessageDelivered', () => {
  it('把来源、目标与正文写进发送方会话并推送渲染层', () => {
    const s = makeRegistrar()
    s.record('inst-a', 'inst-b', '资料库里 X 的归属帮我确认下')

    const saved = s.lastSaved()
    expect(saved.conversationId).toBe('conv-1')
    expect(saved.role).toBe('assistant')
    expect(saved.agentId).toBe('assistant')
    expect(saved.contentJson.type).toBe('assistant_parts')
    const text = saved.contentJson.parts[0]!.text
    expect(text).toContain('灵栖 → 灵栖维护')
    expect(text).toContain('资料库里 X 的归属帮我确认下')

    expect(s.forwardIpcEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'conversation:message:new', sessionKey: 'conv-1' }),
    )
  })

  it('目标名解析不到时回落模型给的原始 to 值', () => {
    const s = makeRegistrar()
    s.record('inst-a', 'some-agent-name', '收到请回复')
    expect(s.lastSaved().contentJson.parts[0]!.text).toContain('灵栖 → some-agent-name')
  })

  it('落库异常不抛出（传话本身已送达，不能反过来打断工具调用）', () => {
    const s = makeRegistrar({
      saveMessage: () => {
        throw new Error('磁盘满了')
      },
    })
    expect(() => s.record('inst-a', 'inst-b', 'ping')).not.toThrow()
  })

  it('找不到会话时静默跳过', () => {
    const s = makeRegistrar()
    s.record('inst-unknown', 'inst-b', 'ping')
    expect(s.saveMessage).not.toHaveBeenCalled()
  })
})
