import { describe, expect, it } from 'vitest'
import { buildWikiBreadcrumbs } from '../../renderer/pages/MemoriesPage/components/wikiBreadcrumbs'

describe('buildWikiBreadcrumbs', () => {
  it('section 视图只显示分区名（分区即大类，v1.1 不再有映射层）', () => {
    expect(buildWikiBreadcrumbs({ kind: 'section', name: '工作' })).toEqual([{ label: '工作' }])
  })

  it('系统分区（收件箱/归档/未分类）不走目录面包屑', () => {
    expect(buildWikiBreadcrumbs({ kind: 'section', name: 'inbox' })).toBeNull()
  })

  it('section 筛选到具体小类时显示两级面包屑', () => {
    expect(buildWikiBreadcrumbs({ kind: 'section', name: '工作' }, '例行')).toEqual([
      { label: '工作', nav: { kind: 'section', name: '工作' } },
      { label: '例行' },
    ])
  })

  it('category 视图返回单级面包屑', () => {
    expect(buildWikiBreadcrumbs({ kind: 'category', name: '生活' })).toEqual([{ label: '生活' }])
  })

  it('subtopic 视图返回大类 + 小类两级', () => {
    expect(buildWikiBreadcrumbs({ kind: 'subtopic', category: '工作', subtopic: '例行' })).toEqual([
      { label: '工作', nav: { kind: 'section', name: '工作' } },
      { label: '例行' },
    ])
  })

  it('subtopic 为 null 时用「未细分」占位（小类可选）', () => {
    expect(buildWikiBreadcrumbs({ kind: 'subtopic', category: '收藏', subtopic: null })).toEqual([
      { label: '收藏', nav: { kind: 'section', name: '收藏' } },
      { label: '未细分' },
    ])
  })

  it('非目录视图返回 null', () => {
    expect(buildWikiBreadcrumbs({ kind: 'inbox' })).toBeNull()
  })
})
