import { describe, expect, it } from 'vitest'
import type { RuntimeMessage } from '../../../hooks/business/useAgentRuntime/agent-runtime-store'
import { planAbort } from './abort-plan'

function user(id: string, text: string, extra: Partial<RuntimeMessage> = {}): RuntimeMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    parts: [],
    timestamp: 1,
    isStreaming: false,
    toolCalls: [],
    ...extra,
  }
}

function assistant(text: string, extra: Partial<RuntimeMessage> = {}): RuntimeMessage {
  return {
    id: `a-${text}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    parts: [],
    timestamp: 2,
    isStreaming: false,
    toolCalls: [],
    ...extra,
  }
}

describe('planAbort', () => {
  it('最后一条用户消息、助手还没产出 → 收回输入框', () => {
    const plan = planAbort([assistant('上一轮回复'), user('u1', '这次的问题')])
    expect(plan.unansweredSteers).toEqual([])
    expect(plan.restoreUserMessage?.id).toBe('u1')
  })

  it('助手只有空占位气泡（没有正文/工具）→ 仍然收回', () => {
    const plan = planAbort([user('u1', '问题'), assistant('')])
    expect(plan.restoreUserMessage?.id).toBe('u1')
  })

  it('助手已经产出正文 → 不收回', () => {
    const plan = planAbort([user('u1', '问题'), assistant('已经开始的回复')])
    expect(plan.restoreUserMessage).toBeNull()
  })

  it('助手已经开始调工具 → 不收回（避免重复执行副作用）', () => {
    const toolPart = {
      type: 'tool' as const,
      id: 't1',
      name: 'bash',
      args: {},
      status: 'running' as const,
    }
    const plan = planAbort([user('u1', '问题'), assistant('', { parts: [toolPart] })])
    expect(plan.restoreUserMessage).toBeNull()
  })

  it('只有思考（thinking part）不算回复 → 收回', () => {
    const thinkingPart = {
      type: 'thinking' as const,
      id: 'th1',
      text: '让我想想',
      status: 'streaming' as const,
    }
    const plan = planAbort([user('u1', '问题'), assistant('', { parts: [thinkingPart] })])
    expect(plan.restoreUserMessage?.id).toBe('u1')
  })

  it('仍在等待注入的插话 → 转新一轮，不回填', () => {
    const steer = user('s1', '顺便加一句', { isSteer: true, steerPending: true })
    const plan = planAbort([user('u1', '问题'), assistant(''), steer])
    expect(plan.unansweredSteers.map((m) => m.id)).toEqual(['s1'])
    expect(plan.restoreUserMessage).toBeNull()
  })

  it('已注入但此后没有任何助手产出的插话 → 也算没被回答', () => {
    const steer = user('s1', '顺便加一句', { isSteer: true, steerPending: false })
    const plan = planAbort([user('u1', '问题'), assistant('之前的回复'), steer, assistant('')])
    expect(plan.unansweredSteers.map((m) => m.id)).toEqual(['s1'])
  })

  it('已注入且此后有助手产出的插话 → 不重发', () => {
    const steer = user('s1', '顺便加一句', { isSteer: true, steerPending: false })
    const plan = planAbort([
      user('u1', '问题'),
      assistant(''),
      steer,
      assistant('插话之后的回复'),
    ])
    expect(plan.unansweredSteers).toEqual([])
    expect(plan.restoreUserMessage).toBeNull()
  })

  it('只重发没被回答的那条插话', () => {
    const answered = user('s1', '第一条', { isSteer: true, steerPending: false })
    const unanswered = user('s2', '第二条', { isSteer: true, steerPending: true })
    const plan = planAbort([
      user('u1', '问题'),
      assistant(''),
      answered,
      assistant('对第一条的回复'),
      unanswered,
    ])
    expect(plan.unansweredSteers.map((m) => m.id)).toEqual(['s2'])
  })

  it('没有用户消息（例如外部渠道触发）→ 什么都不做', () => {
    expect(planAbort([assistant('结果')])).toEqual({
      unansweredSteers: [],
      restoreUserMessage: null,
    })
  })
})
