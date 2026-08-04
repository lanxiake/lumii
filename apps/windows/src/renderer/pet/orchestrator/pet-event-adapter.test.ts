/**
 * pet-event-adapter 单元测试
 * 验证 voice:event → PetBus 转换，重点是 interrupted 标记。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { bindPetEventAdapter } from './pet-event-adapter'
import { PetBus } from './pet-bus'
import type { PetBusEvent } from './pet-bus'

/** 捕获 voice.onEvent 注册的回调，便于手动派发事件 */
let voiceCallback: ((event: unknown) => void) | null = null
let unsubscribeSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  unsubscribeSpy = vi.fn()
  voiceCallback = null
  vi.stubGlobal('window', {
    electronAPI: {
      voice: {
        onEvent: (cb: (event: unknown) => void) => {
          voiceCallback = cb
          return unsubscribeSpy
        },
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pet-event-adapter', () => {
  it('voice:call:state → PetBusVoiceState', () => {
    const bus = new PetBus()
    const events: PetBusEvent[] = []
    bus.on((e) => events.push(e))
    bindPetEventAdapter(bus)

    voiceCallback?.({ type: 'voice:call:state', state: 'speaking', callId: 'c1' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'voice:state', state: 'speaking', interrupted: false, callId: 'c1' })
  })

  it('listening + interrupted=true → interrupted 标记为 true', () => {
    const bus = new PetBus()
    const events: PetBusEvent[] = []
    bus.on((e) => events.push(e))
    bindPetEventAdapter(bus)

    voiceCallback?.({ type: 'voice:call:state', state: 'listening', interrupted: true, callId: 'c1' })
    expect(events[0]).toMatchObject({ kind: 'voice:state', state: 'listening', interrupted: true })
  })

  it('listening 但无 interrupted → interrupted 为 false', () => {
    const bus = new PetBus()
    const events: PetBusEvent[] = []
    bus.on((e) => events.push(e))
    bindPetEventAdapter(bus)

    voiceCallback?.({ type: 'voice:call:state', state: 'listening', callId: 'c1' })
    expect(events[0]).toMatchObject({ interrupted: false })
  })

  it('speaking 态即使带 interrupted 也不视为打断（仅 listening 才算）', () => {
    const bus = new PetBus()
    const events: PetBusEvent[] = []
    bus.on((e) => events.push(e))
    bindPetEventAdapter(bus)

    voiceCallback?.({ type: 'voice:call:state', state: 'speaking', interrupted: true, callId: 'c1' })
    expect(events[0]).toMatchObject({ kind: 'voice:state', state: 'speaking', interrupted: false })
  })

  it('voice:call:ended → PetBusCallEnded', () => {
    const bus = new PetBus()
    const events: PetBusEvent[] = []
    bus.on((e) => events.push(e))
    bindPetEventAdapter(bus)

    voiceCallback?.({ type: 'voice:call:ended', callId: 'c1' })
    expect(events[0]).toEqual({ kind: 'voice:ended', callId: 'c1' })
  })

  it('未知事件类型被忽略', () => {
    const bus = new PetBus()
    const events: PetBusEvent[] = []
    bus.on((e) => events.push(e))
    bindPetEventAdapter(bus)

    voiceCallback?.({ type: 'voice:tts:chunk', samples: [], sampleRate: 22050 })
    expect(events).toHaveLength(0)
  })

  it('dispose 调用 voice 取消订阅', () => {
    const bus = new PetBus()
    const dispose = bindPetEventAdapter(bus)
    dispose()
    expect(unsubscribeSpy).toHaveBeenCalledOnce()
  })
})
