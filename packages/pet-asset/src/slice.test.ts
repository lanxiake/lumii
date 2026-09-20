import { describe, it, expect } from 'vitest'
import { planGrid } from './slice.js'

describe('planGrid', () => {
  it('整除时每格等大', () => {
    const cells = planGrid(1024, 1024, { cols: 2, rows: 2 })
    expect(cells).toHaveLength(4)
    expect(cells.map((c) => [c.x, c.y, c.w, c.h])).toEqual([
      [0, 0, 512, 512],
      [512, 0, 512, 512],
      [0, 512, 512, 512],
      [512, 512, 512, 512],
    ])
  })

  it('除不尽时余数给最后一格 —— 宁可末格宽几像素，也不能切掉边缘的角色像素', () => {
    const cells = planGrid(100, 100, { cols: 3, rows: 3 })
    // 100/3 = 33.33 → 前两格 33，末格吃余数 34
    expect(cells[0].w).toBe(33)
    expect(cells[1].w).toBe(33)
    expect(cells[2].w).toBe(34)
    // 覆盖完整：末格右边界正好等于图宽
    const last = cells.find((c) => c.row === 0 && c.col === 2)!
    expect(last.x + last.w).toBe(100)
    const bottom = cells.find((c) => c.row === 2 && c.col === 0)!
    expect(bottom.y + bottom.h).toBe(100)
  })

  it('行列优先的序号与坐标一致', () => {
    const cells = planGrid(60, 40, { cols: 3, rows: 2 })
    expect(cells.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(cells.map((c) => `${c.row}${c.col}`)).toEqual(['00', '01', '02', '10', '11', '12'])
  })

  it('1×1 就是整图', () => {
    const cells = planGrid(48, 56, { cols: 1, rows: 1 })
    expect(cells).toEqual([{ index: 0, row: 0, col: 0, x: 0, y: 0, w: 48, h: 56 }])
  })

  it('单列 / 单行', () => {
    expect(planGrid(30, 90, { cols: 1, rows: 3 }).map((c) => c.h)).toEqual([30, 30, 30])
    expect(planGrid(90, 30, { cols: 3, rows: 1 }).map((c) => c.w)).toEqual([30, 30, 30])
  })

  it('可以用格宽格高代替行列数', () => {
    const cells = planGrid(96, 64, { cellWidth: 32, cellHeight: 32 })
    expect(cells).toHaveLength(6)
    expect(cells[0].w).toBe(32)
  })

  it('参数非法时抛错，而不是静默返回空网格', () => {
    // 静默返回空会让调用方以为"切出来是空的"，实际是参数写错了
    expect(() => planGrid(100, 100, {})).toThrow()
    expect(() => planGrid(100, 100, { cols: 0, rows: 1 })).toThrow()
    expect(() => planGrid(100, 100, { cols: 1.5, rows: 1 })).toThrow()
    expect(() => planGrid(10, 10, { cols: 20, rows: 1 })).toThrow()
    expect(() => planGrid(0, 100, { cols: 1, rows: 1 })).toThrow()
  })
})
