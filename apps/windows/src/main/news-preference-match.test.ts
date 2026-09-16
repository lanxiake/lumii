import { describe, expect, it } from 'vitest'
import {
  MATCHABLE_FIELDS,
  MAX_HITS,
  matchPreferencesAgainstItems,
  matchRuleAgainstItems,
  ruleMatchesItem,
} from './news-preference-match'
import type { DashboardFeedItem } from './dashboard-feed-store'
import { NEWS_PREF_PRIORITY } from './news-preferences'

const item = (over: Partial<DashboardFeedItem> & { title: string }): DashboardFeedItem => ({
  id: over.title,
  ...over,
})

describe('ruleMatchesItem', () => {
  it('标题 / 摘要 / 来源都参与匹配', () => {
    // 「36氪」既可能是来源也可能是话题，只匹标题会漏掉一半用法
    expect(ruleMatchesItem('融资', item({ title: '某公司完成 B 轮融资' }))).toBe(true)
    expect(ruleMatchesItem('融资', item({ title: '无题', summary: '本轮融资由…' }))).toBe(true)
    expect(ruleMatchesItem('36氪', item({ title: '无题', source: '36氪' }))).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(ruleMatchesItem('ai', item({ title: 'OpenAI 发布新模型' }))).toBe(true)
    expect(ruleMatchesItem('OPENAI', item({ title: 'openai 发布' }))).toBe(true)
  })

  it('空规则不命中任何条目', () => {
    // 这条边界很重要：空规则匹中一切，界面上会显示成「这条规则命中 200 篇」，
    // 用户会以为规则设得太宽，实际上它压根是空的
    expect(ruleMatchesItem('', item({ title: '随便什么' }))).toBe(false)
    expect(ruleMatchesItem('   ', item({ title: '随便什么' }))).toBe(false)
  })

  it('不匹配就是假', () => {
    expect(ruleMatchesItem('新能源', item({ title: '某公司完成 B 轮融资' }))).toBe(false)
  })
})

describe('matchRuleAgainstItems', () => {
  const items = [
    item({ title: 'A 公司融资', timestamp: 100 }),
    item({ title: 'B 公司融资', timestamp: 300 }),
    item({ title: 'C 公司上市', timestamp: 200 }),
  ]

  it('count 是命中总数，hits 只回最近若干条', () => {
    const r = matchRuleAgainstItems('少推', '融资', items, 1)
    expect(r.count).toBe(2)
    expect(r.hits).toHaveLength(1)
  })

  it('命中按时间倒序（用户想看的是「最近还会不会撞上」）', () => {
    const r = matchRuleAgainstItems('少推', '融资', items)
    expect(r.hits.map((h) => h.title)).toEqual(['B 公司融资', 'A 公司融资'])
  })

  it('没有时间戳的条目不炸，排到最后', () => {
    const r = matchRuleAgainstItems('关注', '融资', [
      item({ title: '融资（无时间戳）' }),
      item({ title: '融资（有时间戳）', timestamp: 5 }),
    ])
    expect(r.hits.map((h) => h.title)).toEqual(['融资（有时间戳）', '融资（无时间戳）'])
  })

  it('默认明细上限是 MAX_HITS', () => {
    const many = Array.from({ length: MAX_HITS + 5 }, (_, i) =>
      item({ title: `融资 ${i}`, timestamp: i }),
    )
    const r = matchRuleAgainstItems('少推', '融资', many)
    expect(r.count).toBe(MAX_HITS + 5)
    expect(r.hits).toHaveLength(MAX_HITS)
  })
})

describe('matchPreferencesAgainstItems', () => {
  const items = [
    item({ title: 'AI 融资周报', timestamp: 1 }),
    item({ title: 'AI 芯片进展', timestamp: 2 }),
  ]

  it('返回顺序与裁决链一致（少推在最前）', () => {
    // 界面上「先看到少推、再看到关注」，与规则实际生效的次序一致；
    // 两处各写一份顺序的话迟早会漂开
    const rules = matchPreferencesAgainstItems(
      { 关注: ['AI'], 少推: ['融资'], 来源偏好: [], 推送时段: [] },
      items,
    )
    expect(rules.map((r) => r.field)).toEqual(['少推', '关注'])
  })

  it('推送时段不参与匹配（它是时间窗，不是关键词）', () => {
    expect(MATCHABLE_FIELDS).not.toContain('推送时段')
    const rules = matchPreferencesAgainstItems(
      { 关注: [], 少推: [], 来源偏好: [], 推送时段: ['08:00-09:00'] },
      items,
    )
    expect(rules).toEqual([])
  })

  it('同字段多条规则各算各的', () => {
    const rules = matchPreferencesAgainstItems(
      { 关注: ['AI', '芯片'], 少推: [], 来源偏好: [], 推送时段: [] },
      items,
    )
    expect(rules).toHaveLength(2)
    expect(rules.map((r) => r.count)).toEqual([2, 1])
  })

  it('没有任何偏好时返回空数组', () => {
    expect(
      matchPreferencesAgainstItems({ 关注: [], 少推: [], 来源偏好: [], 推送时段: [] }, items),
    ).toEqual([])
  })

  it('MATCHABLE_FIELDS 就是裁决链本身，不另写一份', () => {
    expect(MATCHABLE_FIELDS).toEqual(NEWS_PREF_PRIORITY)
  })
})
