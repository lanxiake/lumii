import { describe, expect, it, beforeEach } from 'vitest'
import {
  readPersistedSessionThinkingPrefs,
  SESSION_THINKING_STORAGE_KEYS,
  writePersistedThinkingEnabled,
  writePersistedReasoningEffort,
} from './session-thinking-prefs'

describe('session-thinking-prefs', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('未持久化时默认开启思考 + high', () => {
    expect(readPersistedSessionThinkingPrefs()).toEqual({
      thinkingEnabled: true,
      reasoningEffort: 'high',
    })
  })

  it('读取已持久化的关闭思考与 max 强度', () => {
    writePersistedThinkingEnabled(false)
    writePersistedReasoningEffort('max')
    expect(readPersistedSessionThinkingPrefs()).toEqual({
      thinkingEnabled: false,
      reasoningEffort: 'max',
    })
    expect(localStorage.getItem(SESSION_THINKING_STORAGE_KEYS.thinkingEnabled)).toBe('false')
  })
})
