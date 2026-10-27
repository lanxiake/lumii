/**
 * 多选纯函数：加选/减选、Shift 区间、可见性收敛。
 *
 * 区间只在「可见顺序」里算——收起的分组不该被 Shift 顺手选中，
 * 这是用户最容易被坑的地方（以为只选了三张，实际带走了二十张）。
 */
import { describe, expect, it } from 'vitest'
import { applySelect, pruneToVisible } from './selection'

const ORDER = ['a.png', 'b.png', 'c.png', 'd.png']

describe('applySelect', () => {
  it('普通点击=单选，并更新锚点', () => {
    const result = applySelect({
      selected: new Set(['x.png']),
      order: ORDER,
      path: 'b.png',
      mode: 'toggle',
      anchor: 'x.png',
    })
    expect([...result.selected]).toEqual(['b.png'])
    expect(result.anchor).toBe('b.png')
  })

  it('Ctrl 加选再点一次即减选', () => {
    const first = applySelect({
      selected: new Set(['a.png']),
      order: ORDER,
      path: 'c.png',
      mode: 'add',
      anchor: 'a.png',
    })
    expect([...first.selected].sort()).toEqual(['a.png', 'c.png'])

    const second = applySelect({
      selected: first.selected,
      order: ORDER,
      path: 'c.png',
      mode: 'add',
      anchor: first.anchor,
    })
    expect([...second.selected]).toEqual(['a.png'])
  })

  it('Shift 正向/反向区间都覆盖端点，且保留原有选择', () => {
    const forward = applySelect({
      selected: new Set(['a.png']),
      order: ORDER,
      path: 'c.png',
      mode: 'range',
      anchor: 'a.png',
    })
    expect([...forward.selected].sort()).toEqual(['a.png', 'b.png', 'c.png'])

    const backward = applySelect({
      selected: new Set(['a.png']),
      order: ORDER,
      path: 'a.png',
      mode: 'range',
      anchor: 'd.png',
    })
    expect([...backward.selected].sort()).toEqual(['a.png', 'b.png', 'c.png', 'd.png'])
    // 反向拖也保持锚点不动，继续 Shift 是同一条区间
    expect(backward.anchor).toBe('d.png')
  })

  it('锚点已被筛选挤掉时退化成加选，不把看不见的项圈进来', () => {
    const result = applySelect({
      selected: new Set(['z.png']),
      order: ORDER,
      path: 'b.png',
      mode: 'range',
      anchor: 'gone.png',
    })
    expect([...result.selected].sort()).toEqual(['b.png', 'z.png'])
  })
})

describe('pruneToVisible', () => {
  it('只保留仍在可见顺序里的项；无变化时返回新集合但内容一致', () => {
    expect([...pruneToVisible(new Set(['a.png', 'gone.png']), ORDER)]).toEqual(['a.png'])
    expect([...pruneToVisible(new Set(), ORDER)]).toEqual([])
  })
})
