/** @vitest-environment node */
/**
 * 提交窗口 + 中断后状态复位。
 *
 * 回归背景（2026-10-31，用户实测三条）：
 * 1. 点「停止生成」后再说话，语音彻底没反应 —— thinking 没有任何边能回到
 *    listening，handleAudioChunk 又只在 listening/recognizing 跑 ASR。
 * 2. 话没说完就被发出去，且补充的话没反应 —— VAD 静音判据 500ms 就切段，
 *    第一段一提交状态就进 thinking，后半句全丢。
 *
 * 这里不碰真实音频/模型：VAD、ASR、Agent 提交全部打桩，只验时序。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

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

/** 造一个服务实例，引擎/ASR/VAD 全部打桩，直接进 listening */
function makeService(submitted: string[]) {
  const svc = new VoiceCallService(null, async (_sk, content) => {
    submitted.push(content)
  }, stubModelManager())
  svc.setConfig({ vad: { threshold: 0.5, minSpeechMs: 250, minSilenceMs: 500, energyGateMultiplier: 1.5, commitWindowMs: 50 } })

  // 绕过 ensureInitialized：直接注入桩引擎并模拟 startCall 之后的内部状态
  const internals = svc as unknown as Record<string, unknown>
  internals.callId = 'call-1'
  internals.sessionKey = 'sess-1'
  internals.initialized = true
  internals.micless = false
  internals.vad = {
    push: () => [],
    isSpeechDetected: () => false,
    destroy: () => {},
  }
  internals.asrStream = { destroy: () => {} }
  internals.asrProvider = { createStream: () => ({ destroy: () => {} }) }
  internals.stateMachine = new VoiceCallStateMachine()
  const sm = internals.stateMachine as { transition: (s: string) => void }
  sm.transition('listening')
  return { svc, internals, sm }
}

/** 直接调用私有方法做时序验证 */
type Privates = {
  queueOrSubmitUtterance: (text: string) => Promise<void>
  flushHeldUtterance: () => Promise<void>
  discardPendingUtterance: () => void
}

describe('语音提交窗口', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('窗口内的多句合并成一条提交', async () => {
    const submitted: string[] = []
    const { svc } = makeService(submitted)
    const p = svc as unknown as Privates

    await p.queueOrSubmitUtterance('第一句。')
    await p.queueOrSubmitUtterance('第二句。')
    expect(submitted).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(60)
    // submitToAgent 会给每条语音消息加「（语音输入）」后缀，让 Agent 知道输入来源
    expect(submitted).toEqual(['第一句。第二句。（语音输入）'])
  })

  it('thinking 期间的补话被暂存，回到 listening 才放出去', async () => {
    const submitted: string[] = []
    const { svc, internals, sm } = makeService(submitted)
    const p = svc as unknown as Privates
    const stateMachine = internals.stateMachine as {
      transition: (s: string) => boolean
      is: (s: string) => boolean
    }

    expect(stateMachine.transition('thinking')).toBe(true)
    await p.queueOrSubmitUtterance('我再补充一点。')
    expect(submitted).toHaveLength(0)

    // 状态机回 listening 时由注册的监听器放暂存（此处直接调用同一个私有方法）
    await p.flushHeldUtterance()
    expect(submitted).toEqual(['我再补充一点。（语音输入）'])
    expect(sm).toBe(internals.stateMachine)
  })

  it('中断/挂断时丢弃未提交缓冲', async () => {
    const submitted: string[] = []
    const { svc } = makeService(submitted)
    const p = svc as unknown as Privates

    await p.queueOrSubmitUtterance('会被丢弃的话。')
    p.discardPendingUtterance()
    await vi.advanceTimersByTimeAsync(200)
    expect(submitted).toHaveLength(0)
  })
})

describe('中断后状态必须回到可聆听', () => {
  it('thinking 能转到 listening（中断的必经边）', () => {
    const sm = new VoiceCallStateMachine()
    sm.transition('listening')
    expect(sm.transition('thinking')).toBe(true)
    expect(sm.transition('listening')).toBe(true)
  })

  it('aborted 的 message:end 会把 thinking 拉回 listening', async () => {
    const submitted: string[] = []
    const { svc, internals } = makeService(submitted)
    const stateMachine = internals.stateMachine as { is: (s: string) => boolean; transition: (s: string) => boolean }
    stateMachine.transition('thinking')

    // 挂上 onAgentEvent 订阅（startCall 里做，这里手动触发）
    const subs = svc as unknown as { subscribeAgentEvents: () => void }
    subs.subscribeAgentEvents()

    for (const fn of agentHandlers) {
      fn({ type: 'agent:message:end', sessionKey: 'sess-1', stopReason: 'aborted', content: [] })
    }

    expect(stateMachine.is('listening')).toBe(true)
  })
})
