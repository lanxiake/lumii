/**
 * wikiConsolidate：统一归档目录解析
 */
import { describe, expect, it } from 'vitest'
import {
  resolveConsolidateTarget,
  WIKI_CONSOLIDATE_SUBTOPIC,
} from '../../renderer/pages/MemoriesPage/components/wikiConsolidate'

describe('resolveConsolidateTarget', () => {
  it('小类视图解析为同大类下的整合长文', () => {
    expect(
      resolveConsolidateTarget({
        kind: 'subtopic',
        category: '学习资料',
        subtopic: '读书摘抄整理',
      }),
    ).toEqual({ category: '学习资料', subtopic: WIKI_CONSOLIDATE_SUBTOPIC })
  })

  it('大类视图解析为整合长文', () => {
    expect(resolveConsolidateTarget({ kind: 'category', name: '学习资料' })).toEqual({
      category: '学习资料',
      subtopic: WIKI_CONSOLIDATE_SUBTOPIC,
    })
  })

  it('非目录视图返回 null', () => {
    expect(resolveConsolidateTarget({ kind: 'inbox' })).toBeNull()
  })
})
