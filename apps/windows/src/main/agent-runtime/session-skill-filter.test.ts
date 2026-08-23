/**
 * 会话级技能过滤
 *
 * 注意 SkillInfo 类型本身只声明 name，但 getSkills 实际返回体带 id（= UI 的 skillItemId）。
 * 过滤必须按 id 匹配，按 name 只作兜底——否则同名技能会被连带关掉。
 */

import { describe, expect, it } from 'vitest'

/** 与 bridge-instance-factory 中 promptContext.getSkills 的过滤同构 */
function filterSkills<T extends { name: string; id?: string }>(
  skills: readonly T[],
  disabled: readonly string[],
): T[] {
  if (disabled.length === 0) return [...skills]
  return skills.filter((s) => !(s.id && disabled.includes(s.id)) && !disabled.includes(s.name))
}

const SKILLS = [
  { id: 'art-001', name: 'Art' },
  { id: 'brainstorm-002', name: 'brainstorming' },
  { id: 'pdf-003', name: 'pdf' },
]

describe('会话级技能过滤', () => {
  it('按 id 剔除，其余保留', () => {
    expect(filterSkills(SKILLS, ['art-001']).map((s) => s.name)).toEqual(['brainstorming', 'pdf'])
  })

  it('空禁用集时全部保留', () => {
    expect(filterSkills(SKILLS, [])).toHaveLength(3)
  })

  it('禁用多个', () => {
    expect(filterSkills(SKILLS, ['art-001', 'pdf-003']).map((s) => s.name)).toEqual(['brainstorming'])
  })

  it('name 兜底：历史数据里存的是名字也能生效', () => {
    expect(filterSkills(SKILLS, ['pdf']).map((s) => s.name)).toEqual(['Art', 'brainstorming'])
  })

  it('id 不匹配时不误伤同名以外的技能', () => {
    expect(filterSkills(SKILLS, ['not-exist'])).toHaveLength(3)
  })

  it('无 id 字段的技能仍可按 name 过滤', () => {
    const noId = [{ name: 'Art' }, { name: 'pdf' }]
    expect(filterSkills(noId, ['Art']).map((s) => s.name)).toEqual(['pdf'])
  })
})
