import { describe, expect, it } from 'vitest'
import {
  buildTagCounts,
  filterByTag,
  filterByUserPathPrefix,
  formatTagsDraft,
  formatUserPathDraft,
  parseTagsDraft,
  parseUserPathDraft,
} from './wikiFilters'
import type { WikiSourceListItem } from '../../../hooks/business/useWikiPage'

function item(id: string, tags: string[] | null, userPath: string[] | null): WikiSourceListItem {
  return {
    id,
    title: id,
    sourcePath: null,
    mediaType: 'document',
    topicCategory: '学习',
    topicSubtopic: null,
    topicProject: null,
    userPath,
    tags,
    textLength: 0,
    updatedAt: 0,
    useCount: 0,
  }
}

describe('wikiFilters', () => {
  const items = [
    item('a', ['AI', '绘本'], ['outputs', '绘本项目']),
    item('b', ['AI'], ['outputs', '绘本项目', '小星星']),
    item('c', null, ['outputs', '棋牌AI']),
    item('d', ['绘本'], null),
  ]

  it('统计标签并降序排列；忽略空标签', () => {
    expect(buildTagCounts([...items, item('e', ['', '  '], null)])).toEqual([
      { tag: 'AI', count: 2 },
      { tag: '绘本', count: 2 },
    ])
  })

  it('按标签收窄，空标签表示不筛', () => {
    expect(filterByTag(items, 'AI').map((i) => i.id)).toEqual(['a', 'b'])
    expect(filterByTag(items, '绘本').map((i) => i.id)).toEqual(['a', 'd'])
    expect(filterByTag(items, null).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('按路径前缀收窄（层级浏览），前缀须逐段相等', () => {
    expect(filterByUserPathPrefix(items, ['outputs']).map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(filterByUserPathPrefix(items, ['outputs', '绘本项目']).map((i) => i.id)).toEqual(['a', 'b'])
    expect(filterByUserPathPrefix(items, ['outputs', '绘本']).map((i) => i.id)).toEqual([])
    expect(filterByUserPathPrefix(items, []).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('路径草稿解析：分段、去空白，空串回 null', () => {
    expect(parseUserPathDraft('outputs / 绘本项目 /')).toEqual(['outputs', '绘本项目'])
    expect(parseUserPathDraft('outputs\\绘本项目')).toEqual(['outputs', '绘本项目'])
    expect(parseUserPathDraft('   ')).toBeNull()
    expect(formatUserPathDraft(['outputs', '绘本项目'])).toBe('outputs / 绘本项目')
    expect(formatUserPathDraft(null)).toBe('')
  })

  it('标签草稿解析：中英文逗号、去重保序，空串回 null', () => {
    expect(parseTagsDraft('AI, 绘本，AI ,, ')).toEqual(['AI', '绘本'])
    expect(parseTagsDraft(' ,， ')).toBeNull()
    expect(formatTagsDraft(['AI', '绘本'])).toBe('AI, 绘本')
  })
})
