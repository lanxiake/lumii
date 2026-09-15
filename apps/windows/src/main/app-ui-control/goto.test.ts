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

  // 下面两份清单**故意手抄**：它们是「运行时可接受的取值」的独立副本，
  // 与 goto.ts/types.ts 一起改才算数（`autonomous` 当年改成 `experimental` 时
  // 只改了实现、漏了这里，本测试就是为此报的警——别把它们抽成共享常量，那样就测不到漂移了）。
  it('所有 ViewType 均合法', () => {
    const views = [
      'dashboard',
      'chat',
      'autonomous',
      'skills',
      'settings',
      'memories',
      'wiki',
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
      'experimental',
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
