import { describe, expect, it } from 'vitest'
import { parseGotoInput } from './goto'

describe('parseGotoInput', () => {
  it('合法 view 返回解析结果', () => {
    const result = parseGotoInput({ view: 'chat' })
    expect(result).toEqual({ ok: true, input: { view: 'chat' } })
  })

  it('合法 view + category 返回解析结果', () => {
    const result = parseGotoInput({ view: 'settings', category: 'voice' })
    expect(result).toEqual({ ok: true, input: { view: 'settings', category: 'voice' } })
  })

  it('所有 ViewType 均合法', () => {
    const views = [
      'dashboard',
      'chat',
      'skills',
      'settings',
      'memories',
      'agents',
      'cron',
      'plugins',
      'mcp',
    ] as const
    for (const view of views) {
      expect(parseGotoInput({ view })).toEqual({ ok: true, input: { view } })
    }
  })

  it('所有 MergedSettingsCategory 均合法', () => {
    const categories = [
      'general',
      'workspace',
      'modelConfig',
      'voice',
      'channels',
      'codingDev',
      'pet',
      'usage',
      'privacy',
      'aboutAndUpdate',
    ] as const
    for (const category of categories) {
      const result = parseGotoInput({ view: 'settings', category })
      expect(result).toEqual({ ok: true, input: { view: 'settings', category } })
    }
  })

  it('非法 view 返回 usage', () => {
    expect(parseGotoInput({ view: 'unknown' })).toEqual({ ok: false, error: 'usage' })
    expect(parseGotoInput({ view: '' })).toEqual({ ok: false, error: 'usage' })
  })

  it('非法 category 返回 usage', () => {
    expect(parseGotoInput({ view: 'settings', category: 'invalid' })).toEqual({
      ok: false,
      error: 'usage',
    })
  })

  it('缺少 view 返回 usage', () => {
    expect(parseGotoInput({})).toEqual({ ok: false, error: 'usage' })
    expect(parseGotoInput(null)).toEqual({ ok: false, error: 'usage' })
    expect(parseGotoInput(undefined)).toEqual({ ok: false, error: 'usage' })
  })
})
