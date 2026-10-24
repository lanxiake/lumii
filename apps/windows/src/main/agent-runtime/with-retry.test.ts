import { describe, expect, it, vi } from 'vitest'
import { retryDelay, withRetry } from './with-retry'

const fast = { backoffMs: 1, maxBackoffMs: 10 }

describe('retryDelay', () => {
  it('指数退避并封顶', () => {
    const cfg = { backoffMs: 100, backoffMultiplier: 2, maxBackoffMs: 250 }
    expect(retryDelay(1, cfg)).toBe(100)
    expect(retryDelay(2, cfg)).toBe(200)
    expect(retryDelay(3, cfg)).toBe(250)
    expect(retryDelay(9, cfg)).toBe(250)
  })
})

describe('withRetry', () => {
  it('可重试错误重试后成功', async () => {
    let calls = 0
    const onRetry = vi.fn()
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error('read ECONNRESET')
        return 'ok'
      },
      { ...fast, maxAttempts: 3, onRetry },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0]?.[0]).toBe(1)
  })

  it('不可重试错误立即抛出，不浪费用户时间', async () => {
    let calls = 0
    await expect(
      withRetry(async () => {
        calls++
        throw new Error('permission denied')
      }, { ...fast, maxAttempts: 5 }),
    ).rejects.toThrow('permission denied')
    expect(calls).toBe(1)
  })

  it('达到上限后抛出最后一次错误', async () => {
    let calls = 0
    await expect(
      withRetry(async () => {
        calls++
        throw new Error('ETIMEDOUT')
      }, { ...fast, maxAttempts: 3 }),
    ).rejects.toThrow('ETIMEDOUT')
    expect(calls).toBe(3)
  })

  it('中断信号期间不再重试', async () => {
    const controller = new AbortController()
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          controller.abort()
          throw new Error('ECONNREFUSED')
        },
        { ...fast, maxAttempts: 5, signal: controller.signal },
      ),
    ).rejects.toThrow('ECONNREFUSED')
    expect(calls).toBe(1)
  })

  it('退避等待可被中断', async () => {
    const controller = new AbortController()
    const promise = withRetry(
      async () => {
        throw new Error('503 Service Unavailable')
      },
      { backoffMs: 5_000, maxBackoffMs: 5_000, maxAttempts: 3, signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 10)
    await expect(promise).rejects.toThrow('aborted')
  })
})
