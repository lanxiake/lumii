import { describe, expect, it } from 'vitest'
import { isMcpEnabledForSession } from './mcp-session-state'

describe('isMcpEnabledForSession', () => {
  it('returns disabled when the server is listed in the session override', () => {
    expect(isMcpEnabledForSession('calendar', ['calendar'])).toBe(false)
  })

  it('returns enabled when the session does not disable the server', () => {
    expect(isMcpEnabledForSession('calendar', [])).toBe(true)
  })
})
