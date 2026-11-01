import { describe, expect, it } from 'vitest'
import { decideVoiceFinalAction } from './voice-final-routing'

describe('语音定稿分流', () => {
  it('有活跃 run → 插话（打断/纠偏），不新建消息', () => {
    expect(
      decideVoiceFinalAction({ isSending: true, hasActiveRun: true, queueLen: 0 }),
    ).toBe('steer')
  })

  it('只是本地发送中、没有 run → 进短队列', () => {
    expect(
      decideVoiceFinalAction({ isSending: true, hasActiveRun: false, queueLen: 0 }),
    ).toBe('queue')
  })

  it('队列满也照样收下，不丢用户的话', () => {
    expect(
      decideVoiceFinalAction({ isSending: true, hasActiveRun: false, queueLen: 2 }),
    ).toBe('queue')
  })

  it('空闲 → 直接发送', () => {
    expect(
      decideVoiceFinalAction({ isSending: false, hasActiveRun: false, queueLen: 0 }),
    ).toBe('send')
  })
})
