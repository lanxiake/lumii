import { describe, expect, it } from 'vitest'

import { filterPluginCategories } from './settings-categories'

describe('filterPluginCategories', () => {
  const categories = [{ id: 'general' }, { id: 'usage' }, { id: 'aboutAndUpdate' }]

  it('插件启用时保留它的分类，核心分类始终保留', () => {
    const visible = filterPluginCategories(categories, (id) => id === 'com.lumii.usage')
    expect(visible.map((c) => c.id)).toEqual(['general', 'usage', 'aboutAndUpdate'])
  })

  it('插件停用时整块分类消失（不是灰掉）', () => {
    const visible = filterPluginCategories(categories, () => false)
    expect(visible.map((c) => c.id)).toEqual(['general', 'aboutAndUpdate'])
  })

  it('只认登记过的分类：未登记 id 即使同名也不受插件状态影响', () => {
    const visible = filterPluginCategories([{ id: 'not-registered' }], () => false)
    expect(visible).toHaveLength(1)
  })
})
