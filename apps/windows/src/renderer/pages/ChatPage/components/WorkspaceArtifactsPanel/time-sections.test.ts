/**
 * 时间分节：按本地日历天分「今天 / 昨天 / 具体日期」，不按 24 小时。
 */
import { describe, expect, it } from 'vitest'
import { groupBySections, sectionOf } from './time-sections'

const NOW = new Date(2026, 9, 27, 10, 0, 0) // 2026-10-27 10:00 本地

describe('sectionOf', () => {
  it('今天 00:00 起算今天；昨天 23:59 仍算昨天', () => {
    expect(sectionOf(new Date(2026, 9, 27, 0, 0, 0).getTime(), NOW).label).toBe('今天')
    expect(sectionOf(new Date(2026, 9, 26, 23, 59, 0).getTime(), NOW).label).toBe('昨天')
  })

  it('更早给具体日期（补零）', () => {
    expect(sectionOf(new Date(2026, 9, 24, 8, 0, 0).getTime(), NOW).label).toBe('2026-10-24')
    expect(sectionOf(new Date(2026, 0, 5, 8, 0, 0).getTime(), NOW).label).toBe('2026-01-05')
  })

  it('跨年：1-1 看 12-31 仍是「昨天」；12-30 才是具体日期', () => {
    const jan = new Date(2027, 0, 1, 9, 0, 0)
    expect(sectionOf(new Date(2026, 11, 31, 23, 0, 0).getTime(), jan).label).toBe('昨天')
    expect(sectionOf(new Date(2026, 11, 30, 23, 0, 0).getTime(), jan).label).toBe('2026-12-30')
    expect(sectionOf(new Date(2026, 11, 30, 23, 0, 0).getTime(), jan).key).toBe(
      sectionOf(new Date(2026, 11, 30, 1, 0, 0).getTime(), jan).key,
    )
  })
})

describe('groupBySections', () => {
  it('保持输入顺序，连续同日合到一节', () => {
    const items = [
      { t: new Date(2026, 9, 27, 9, 0).getTime() },
      { t: new Date(2026, 9, 27, 1, 0).getTime() },
      { t: new Date(2026, 9, 26, 20, 0).getTime() },
      { t: new Date(2026, 9, 20, 20, 0).getTime() },
    ]
    const sections = groupBySections(items, (item) => item.t, NOW)
    expect(sections.map((section) => section.section.label)).toEqual([
      '今天',
      '昨天',
      '2026-10-20',
    ])
    expect(sections[0]!.items).toHaveLength(2)
  })
})
