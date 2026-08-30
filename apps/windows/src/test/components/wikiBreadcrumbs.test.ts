import { describe, expect, it } from 'vitest'
import { buildWikiBreadcrumbs } from '../../renderer/pages/MemoriesPage/components/wikiBreadcrumbs'

describe('buildWikiBreadcrumbs', () => {
  it('section 视图只显示分区名', () => {
    expect(buildWikiBreadcrumbs({ kind: 'section', name: 'work' })).toEqual([{ label: '工作' }])
  })

  it('category 视图可返回分区', () => {
    expect(buildWikiBreadcrumbs({ kind: 'category', name: '计划与复盘' })).toEqual([
      { label: '生活', nav: { kind: 'section', name: 'life' } },
      { label: '计划与复盘' },
    ])
  })

  it('subtopic 单大类分区省略中间层', () => {
    expect(
      buildWikiBreadcrumbs({ kind: 'subtopic', category: '做事记录', subtopic: '会议记录' }),
    ).toEqual([
      { label: '工作', nav: { kind: 'section', name: 'work' } },
      { label: '会议记录' },
    ])
  })

  it('subtopic 多大类分区保留 category 层', () => {
    expect(
      buildWikiBreadcrumbs({ kind: 'subtopic', category: '模板参考', subtopic: '设计稿' }),
    ).toEqual([
      { label: '收藏', nav: { kind: 'section', name: 'collection' } },
      { label: '模板参考', nav: { kind: 'category', name: '模板参考' } },
      { label: '设计稿' },
    ])
  })

  it('非目录视图返回 null', () => {
    expect(buildWikiBreadcrumbs({ kind: 'inbox' })).toBeNull()
  })
})
