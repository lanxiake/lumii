/**
 * PetBus 单元测试
 */
import { describe, it, expect, vi } from 'vitest'
import { PetBus } from './pet-bus'

describe('PetBus', () => {
  it('emit 调用所有订阅者', () => {
    const bus = new PetBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    bus.on(h1)
    bus.on(h2)
    bus.emit({ kind: 'voice:ended', callId: 'c1' })
    expect(h1).toHaveBeenCalledOnce()
    expect(h2).toHaveBeenCalledOnce()
  })

  it('取消订阅后不再收到事件', () => {
    const bus = new PetBus()
    const h = vi.fn()
    const off = bus.on(h)
    off()
    bus.emit({ kind: 'voice:ended', callId: 'c1' })
    expect(h).not.toHaveBeenCalled()
  })

  it('某个 handler 抛错不影响其他 handler', () => {
    const bus = new PetBus()
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    bus.on(bad)
    bus.on(good)
    expect(() => bus.emit({ kind: 'voice:ended', callId: 'c1' })).not.toThrow()
    expect(good).toHaveBeenCalledOnce()
  })

  it('clear 移除所有订阅', () => {
    const bus = new PetBus()
    const h = vi.fn()
    bus.on(h)
    bus.clear()
    bus.emit({ kind: 'voice:ended', callId: 'c1' })
    expect(h).not.toHaveBeenCalled()
  })
})
