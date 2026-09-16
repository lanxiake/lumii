/**
 * skill_search 吸收 skill_list 之后的两条路径。
 *
 * 原来有个独立的 `skill_list`，它的全部实现就是「无过滤条件地列举技能」——
 * 与 skill_search 的唯一区别是有没有 query 参数。合并的正当性全押在
 * 「不带 query 时行为与原 skill_list 完全一致」上，所以这条守住它。
 */
import { describe, expect, it } from 'vitest'
import { skillSearchToolConfig } from './skill-tools.js'
import type { ToolExecutionContext } from '../../types/tool.js'

const SKILLS = [
  { name: 'weather', description: '查天气', whenToUse: '用户问天气时' },
  { name: 'code-review', description: 'PR review 流程', whenToUse: 'review 代码时' },
] as never

function ctx(): ToolExecutionContext {
  return { getSkills: () => SKILLS } as never
}

async function run(params: Record<string, unknown>): Promise<{ skills: unknown[]; total: number; hint?: string }> {
  const result = await skillSearchToolConfig.execute('tc', params as never, ctx())
  return JSON.parse((result.content[0] as { text: string }).text)
}

describe('skill_search', () => {
  it('不带 query = 列出全部（原 skill_list 的行为）', async () => {
    const out = await run({})
    expect(out.total).toBe(2)
    expect(out.skills).toHaveLength(2)
  })

  it('query 为空串也当作「列出全部」，而不是「匹配不到」', async () => {
    const out = await run({ query: '   ' })
    expect(out.total).toBe(2)
  })

  it('带 query 时按关键词过滤', async () => {
    const out = await run({ query: '天气' })
    expect(out.total).toBe(1)
  })

  it('匹配不到时给 skillnet 兜底提示（且带上原始 query）', async () => {
    const out = await run({ query: '不存在的技能xyz' })
    expect(out.total).toBe(0)
    expect(out.hint).toContain('不存在的技能xyz')
    expect(out.hint).toContain('skillnet')
  })

  it('getSkills 缺失时给出可读结论而不是抛错', async () => {
    const result = await skillSearchToolConfig.execute('tc', {} as never, {} as never)
    const text = (result.content[0] as { text: string }).text
    expect(text.length).toBeGreaterThan(0)
  })
})
