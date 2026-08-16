import { describe, expect, it } from 'vitest'
import { createSlidingWindowRateLimiter } from './rate-limit'

describe('createSlidingWindowRateLimiter', () => {
  it('窗口内第 limit+1 次拒绝', () => {
    let t = 1_000_000
    const lim = createSlidingWindowRateLimiter({
      limit: 3,
      windowMs: 60_000,
      now: () => t,
    })
    expect(lim.tryConsume()).toBe(true)
    expect(lim.tryConsume()).toBe(true)
    expect(lim.tryConsume()).toBe(true)
    expect(lim.tryConsume()).toBe(false)
  })

  it('时间滑出窗口后恢复', () => {
    let t = 0
    const lim = createSlidingWindowRateLimiter({
      limit: 2,
      windowMs: 60_000,
      now: () => t,
    })
    expect(lim.tryConsume()).toBe(true)
    expect(lim.tryConsume()).toBe(true)
    expect(lim.tryConsume()).toBe(false)
    t = 60_000
    expect(lim.tryConsume()).toBe(true)
  })
})
