import { describe, expect, it } from 'vitest'
import { COMMAND_ALLOWLIST, findDeniedField, isCommandExposed } from './command-allowlist'

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

  it('放行 Task 6 新增记忆命令（search/stats/archiveCold/unarchive/rebuildIndex）', () => {
    for (const t of [
      'agent:memories:search',
      'agent:memories:stats',
      'agent:memories:archiveCold',
      'agent:memories:unarchive',
      'agent:memories:rebuildIndex',
    ]) {
      expect(isCommandExposed(t)).toBe(true)
    }
  })

  it('放行 Wiki inbox:count（CLI 计数与 UI 徽章同源）', () => {
    expect(isCommandExposed('wiki:inbox:count')).toBe(true)
  })

  it('放行压缩自动化所需命令', () => {
    for (const t of [
      'conversation:create',
      'conversation:messages',
      'conversation:context-usage',
      'user:send',
      'user:abort',
      'user:compact-context',
      'user:abort-compact-context',
    ]) {
      expect(isCommandExposed(t)).toBe(true)
    }
  })
})

describe('findDeniedField', () => {
  it('user:send 纯文本放行', () => {
    expect(findDeniedField({ type: 'user:send', sessionKey: 's', content: 'hi' })).toBe(null)
  })

  it('user:send 携带附件路径被拒（否则等于开了 files 读能力的侧门）', () => {
    expect(
      findDeniedField({
        type: 'user:send',
        sessionKey: 's',
        content: 'hi',
        imageAttachmentPaths: ['C:/secrets/id_rsa'],
      }),
    ).toBe('imageAttachmentPaths')
    expect(
      findDeniedField({ type: 'user:send', sessionKey: 's', content: 'hi', attachments: ['x'] }),
    ).toBe('attachments')
    expect(
      findDeniedField({ type: 'user:send', sessionKey: 's', content: 'hi', agentId: 'a' }),
    ).toBe('agentId')
  })

  it('无字段限制的命令一律放行；非法 body 不抛异常', () => {
    expect(findDeniedField({ type: 'cron:list' })).toBe(null)
    expect(findDeniedField(null)).toBe(null)
    expect(findDeniedField({ type: 123 })).toBe(null)
  })
})
