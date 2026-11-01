/** @vitest-environment node */
/**
 * 唤醒判定逻辑（不碰真模型：引擎用桩，只验段筛选/冷却/匹配）。
 */
import { describe, expect, it, vi } from 'vitest'
import { VoiceWakeService, type WakeEngineProvider } from './voice-wake-service'

function stubEngine(text: string): WakeEngineProvider & { pushCalls: number } {
  return {
    pushCalls: 0,
    ensureWakeEngine: async () => {},
    pushVad(samples: Float32Array) {
      this.pushCalls++
      // 一次性把所有帧当成一段语音返回，方便断言
      return [samples]
    },
    transcribeSegment: async () => text,
  }
}

/** 1 秒 16k 的静音段——长度落在唤醒判定窗口内 */
function seg(seconds = 1): Float32Array {
  return new Float32Array(Math.round(16000 * seconds))
}

describe('唤醒判定', () => {
  it('未 attach 时不消费任何帧', () => {
    const engine = stubEngine('灵栖灵栖')
    const onWake = vi.fn()
    const svc = new VoiceWakeService(engine, onWake)
    svc.feed(seg())
    expect(engine.pushCalls).toBe(0)
    expect(onWake).not.toHaveBeenCalled()
  })

  it('命中「灵栖灵栖」触发回调', async () => {
    const engine = stubEngine('灵栖灵栖')
    const onWake = vi.fn()
    const svc = new VoiceWakeService(engine, onWake)
    await svc.attach()
    svc.feed(seg())
    await vi.waitFor(() => expect(onWake).toHaveBeenCalledTimes(1))
    expect(onWake.mock.calls[0]![0]).toMatchObject({ matched: '灵栖灵栖', rawText: '灵栖灵栖' })
  })

  it('只说一遍不触发', async () => {
    const engine = stubEngine('灵栖')
    const onWake = vi.fn()
    const svc = new VoiceWakeService(engine, onWake)
    await svc.attach()
    svc.feed(seg())
    await new Promise((r) => setTimeout(r, 20))
    expect(onWake).not.toHaveBeenCalled()
  })

  it('冷却期内不重复触发', async () => {
    const engine = stubEngine('灵栖灵栖')
    const onWake = vi.fn()
    const svc = new VoiceWakeService(engine, onWake)
    await svc.attach()
    svc.feed(seg())
    await vi.waitFor(() => expect(onWake).toHaveBeenCalledTimes(1))
    svc.feed(seg())
    await new Promise((r) => setTimeout(r, 20))
    expect(onWake).toHaveBeenCalledTimes(1)
  })

  it('太短的段不做判定（语气词/噪声）', async () => {
    const engine = stubEngine('灵栖灵栖')
    const transcribe = vi.spyOn(engine, 'transcribeSegment')
    const svc = new VoiceWakeService(engine, vi.fn())
    await svc.attach()
    svc.feed(seg(0.2))
    await new Promise((r) => setTimeout(r, 20))
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('detach 之后不再判定', async () => {
    const engine = stubEngine('灵栖灵栖')
    const onWake = vi.fn()
    const svc = new VoiceWakeService(engine, onWake)
    await svc.attach()
    svc.detach()
    svc.feed(seg())
    await new Promise((r) => setTimeout(r, 20))
    expect(onWake).not.toHaveBeenCalled()
  })
})
