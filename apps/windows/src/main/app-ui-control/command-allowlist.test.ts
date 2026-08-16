import { describe, expect, it } from 'vitest'
import { COMMAND_ALLOWLIST, isCommandExposed } from './command-allowlist'

describe('COMMAND_ALLOWLIST', () => {
  it('允许 cron:list / tools:toggle / session:preferredModel:set', () => {
    expect(isCommandExposed('cron:list')).toBe(true)
    expect(isCommandExposed('tools:toggle')).toBe(true)
    expect(isCommandExposed('session:preferredModel:set')).toBe(true)
  })

  it('拒绝高危命令', () => {
    for (const t of [
      'mcp:writeConfigFile',
      'mcp:upsert',
      'user:send',
      'user:permission:respond',
      'files:delete',
      'files:list',
      'storage:exportJsonl',
      'agentInstance:prompt',
      'image:generate',
      'runtime:featureFlags:set',
    ]) {
      expect(isCommandExposed(t)).toBe(false)
    }
  })

  it('未知类型默认拒绝；非字符串拒绝', () => {
    expect(isCommandExposed('totally:unknown')).toBe(false)
    expect(isCommandExposed(null)).toBe(false)
    expect(isCommandExposed(undefined)).toBe(false)
  })

  it('是 ReadonlySet 且含设计表全部开放项', () => {
    expect(COMMAND_ALLOWLIST).toBeInstanceOf(Set)
    expect(COMMAND_ALLOWLIST.has('codingDev:setBackend')).toBe(true)
    expect(COMMAND_ALLOWLIST.has('agent:memories:list')).toBe(true)
    expect(COMMAND_ALLOWLIST.has('mcp:status')).toBe(true)
  })
})
