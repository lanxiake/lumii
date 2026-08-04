import { describe, expect, it } from 'vitest'
import { petSessionMatchesEvent } from './pet-session-match'

describe('petSessionMatchesEvent', () => {
  it('根会话键匹配', () => {
    expect(
      petSessionMatchesEvent('local:abc', {
        rootSessionKey: 'local:abc',
        sessionKey: 'child-1',
      }),
    ).toBe(true)
  })

  it('直接 sessionKey 匹配', () => {
    expect(
      petSessionMatchesEvent('local:abc', { sessionKey: 'local:abc' }),
    ).toBe(true)
  })

  it('不匹配时返回 false', () => {
    expect(
      petSessionMatchesEvent('local:abc', {
        rootSessionKey: 'local:other',
        sessionKey: 'child-1',
      }),
    ).toBe(false)
  })
})
