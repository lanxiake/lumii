import { describe, expect, it, vi } from 'vitest'
import {
  handleSessionPreferredModelPrime,
  handleSessionPreferredModelSet,
} from './misc-commands'

describe('session preferred model commands', () => {
  it('persists an explicit model selection', () => {
    const bridge = {
      setSessionPreferredModel: vi.fn(),
      primeSessionModelCompaction: vi.fn(),
      getSessionContextUsage: vi.fn(() => ({
        usedTokens: 0,
        contextWindow: 200_000,
        triggerThreshold: 0.8,
      })),
    }

    handleSessionPreferredModelSet(bridge as never, {
      type: 'session:preferredModel:set',
      sessionKey: 'cron:seed-focus-check',
      modelId: 'gpt-5.6-luna',
    })

    expect(bridge.setSessionPreferredModel).toHaveBeenCalledWith(
      'cron:seed-focus-check',
      'gpt-5.6-luna',
    )
    expect(bridge.primeSessionModelCompaction).not.toHaveBeenCalled()
  })

  it('primes a session without changing its saved model selection', () => {
    const bridge = {
      setSessionPreferredModel: vi.fn(),
      primeSessionModelCompaction: vi.fn(),
      getSessionContextUsage: vi.fn(() => ({
        usedTokens: 0,
        contextWindow: 200_000,
        triggerThreshold: 0.8,
      })),
    }

    handleSessionPreferredModelPrime(bridge as never, {
      type: 'session:preferredModel:prime',
      sessionKey: 'conversation-1',
      modelId: 'gpt-5.6-luna',
    })

    expect(bridge.primeSessionModelCompaction).toHaveBeenCalledWith(
      'conversation-1',
      'gpt-5.6-luna',
    )
    expect(bridge.setSessionPreferredModel).not.toHaveBeenCalled()
  })
})
