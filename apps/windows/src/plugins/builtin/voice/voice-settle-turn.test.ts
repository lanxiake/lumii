/** @vitest-environment node */
/**
 * 回合收口：`settleTurn` 与「中间态/终态」的区分。
 *
 * 回归背景（2026-11-01 计划 §2.6）：
 * - G1：isSending 时 final 卡在输入框，主进程却已进 thinking → 永久悬停。
 * - G6：LLM 报错走 agent:error，没有 message:end → 通话僵死（原始 bug 1 同型）。
 * - G7：message:end + tool_use 是**中间态**，旧代码的空回复兜底会提前把状态拉回
 *   listening；而 onDelta 只在 thinking 才转 speaking，于是 TTS 播着、状态是 listening，
 *   用户开口就把自己的 TTS 采进 ASR。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => process.cwd() },
}))

const agentHandlers: Array<(event: unknown) => void> = []
vi.mock('../../../main/kernel/agent-event-stream', () => ({
  onAgentEvent: (fn: (event: unknown) => void) => {
    agentHandlers.push(fn)
    return () => {
      const i = agentHandlers.indexOf(fn)
      if (i >= 0) agentHandlers.splice(i, 1)
    }
  },
}))
vi.mock('../../../main/kernel/voice-event-mirror', () => ({
  getVoiceEventMirrors: () => [],
}))
vi.mock('../../../main/onnx-runtime-gate', () => ({
  sherpaFirst: () => true,
  sherpaDone: () => {},
}))

import { VoiceCallService } from './voice-service'
import { VoiceCallStateMachine } from './voice-state-machine'
import type { VoiceModelManager } from './model-manager'

function stubModelManager(): VoiceModelManager {
  return {
    isTtsReady: () => true,
    areRequiredModelsReady: () => true,
    getModelPaths: async () => ({ vad: '', asr: '', tts: '' }),
  } as unknown as VoiceModelManager
}

type Internals = {
  callId: string | null
  sessionKey: string | null
  isTtsBusy: boolean
  ttsQueue: Array<{ text: string }>
  settlePending: boolean
  stateMachine: VoiceCallStateMachine
  settleTurn: (reason: string, opts?: { discardTts?: boolean }) => void
  subscribeAgentEvents: () => void
  enqueueTts: (text: string) => void
}

/** 造一个「通话中、状态在 target」的服务实例（引擎全部不碰） */
function makeService(target: 'thinking' | 'speaking' | 'listening') {
  const svc = new VoiceCallService(null, async () => {}, stubModelManager())
  const internals = svc as unknown as Internals
  internals.callId = 'call-1'
  internals.sessionKey = 'sess-1'
  internals.stateMachine = new VoiceCallStateMachine()
  internals.stateMachine.transition('listening')
  if (target !== 'listening') {
    internals.stateMachine.transition('thinking')
    if (target === 'speaking') internals.stateMachine.transition('speaking')
  }
  return { svc, internals }
}

function emit(event: Record<string, unknown>): void {
  for (const fn of agentHandlers) fn(event)
}

describe('settleTurn 幂等收口', () => {
  beforeEach(() => {
    agentHandlers.length = 0
  })

  it('空闲时三条终态都回 listening，且重复调用幂等', () => {
    const { internals } = makeService('thinking')
    internals.settleTurn('agent:idle')
    expect(internals.stateMachine.is('listening')).toBe(true)
    expect(() => internals.settleTurn('agent:idle')).not.toThrow()
    expect(internals.stateMachine.is('listening')).toBe(true)
  })

  it('TTS 还在合成时不切状态，只记 settlePending（避免截断 AI 的话）', () => {
    const { internals } = makeService('thinking')
    internals.stateMachine.transition('speaking')
    internals.isTtsBusy = true

    internals.settleTurn('agent:idle')

    expect(internals.settlePending).toBe(true)
    expect(internals.stateMachine.is('speaking')).toBe(true)
  })

  it('用户打断（discardTts）立刻清队列并回 listening', () => {
    const { internals } = makeService('thinking')
    internals.stateMachine.transition('speaking')
    internals.isTtsBusy = true
    internals.ttsQueue = [{ text: '没说完的话' }]

    internals.settleTurn('aborted', { discardTts: true })

    expect(internals.ttsQueue).toHaveLength(0)
    expect(internals.isTtsBusy).toBe(false)
    expect(internals.settlePending).toBe(false)
    expect(internals.stateMachine.is('listening')).toBe(true)
  })
})

describe('agent 事件订阅（G6/G7）', () => {
  beforeEach(() => {
    agentHandlers.length = 0
  })

  it('agent:error 让悬停的 thinking 回到 listening', () => {
    const { internals } = makeService('thinking')
    internals.subscribeAgentEvents()

    emit({ type: 'agent:error', sessionKey: 'sess-1', errorCode: 'X', errorMessage: '模型挂了' })

    expect(internals.stateMachine.is('listening')).toBe(true)
  })

  it('agent:idle 收口整个 run', () => {
    const { internals } = makeService('thinking')
    internals.subscribeAgentEvents()

    emit({ type: 'agent:idle', sessionKey: 'sess-1', runId: 'r1' })

    expect(internals.stateMachine.is('listening')).toBe(true)
  })

  it('message:end + tool_use 是中间态：状态不动', () => {
    const { internals } = makeService('thinking')
    internals.subscribeAgentEvents()

    emit({
      type: 'agent:message:end',
      sessionKey: 'sess-1',
      stopReason: 'tool_use',
      content: [],
    })

    expect(internals.stateMachine.is('thinking')).toBe(true)
  })

  it('别的会话的事件不干扰当前通话', () => {
    const { internals } = makeService('thinking')
    internals.subscribeAgentEvents()

    emit({ type: 'agent:error', sessionKey: 'other-session', errorCode: 'X', errorMessage: '' })

    expect(internals.stateMachine.is('thinking')).toBe(true)
  })
})
