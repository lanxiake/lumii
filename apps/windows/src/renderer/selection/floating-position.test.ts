/**
 * 浮动层定位测试
 *
 * 视口由参数传入，所以不需要 jsdom 的窗口尺寸 —— 这里验的是几何规则本身。
 */
import { describe, expect, it } from 'vitest'
import { GAP, placeFloating, VIEWPORT_PAD, type FloatingViewport } from './floating-position'
import type { SnapshotRect } from './snapshot'

function rect(top: number, left: number, width: number, height: number): SnapshotRect {
  return { top, left, width, height }
}

const VIEWPORT: FloatingViewport = { width: 1000, height: 800 }
const SIZE = { width: 200, height: 40 }

describe('placeFloating', () => {
  it('空间够时按 preferred 落位，水平相对锚点居中', () => {
    const pos = placeFloating(rect(400, 400, 200, 20), SIZE, 'top', VIEWPORT)

    expect(pos).toEqual({ top: 400 - 40 - GAP, left: 400, placement: 'top' })
  })

  it('preferred=top 但上方放不下时翻到下方', () => {
    const pos = placeFloating(rect(20, 300, 200, 20), SIZE, 'top', VIEWPORT)

    expect(pos.placement).toBe('bottom')
    expect(pos.top).toBe(20 + 20 + GAP)
  })

  it('preferred=bottom 但下方放不下时翻到上方', () => {
    const pos = placeFloating(rect(770, 300, 200, 20), SIZE, 'bottom', VIEWPORT)

    expect(pos.placement).toBe('top')
    expect(pos.top).toBe(770 - 40 - GAP)
  })

  it('刚好放得下就不翻（判定用 >=）', () => {
    // spaceAbove 恰好等于 高度 + GAP + 留白
    const exact = SIZE.height + GAP + VIEWPORT_PAD
    expect(placeFloating(rect(exact, 300, 200, 20), SIZE, 'top', VIEWPORT).placement).toBe('top')
    // 少一个像素就翻
    expect(placeFloating(rect(exact - 1, 300, 200, 20), SIZE, 'top', VIEWPORT).placement).toBe(
      'bottom',
    )
  })

  it('两侧都放不下时取空间更大的一侧，溢出由夹紧兜底', () => {
    const small: FloatingViewport = { width: 1000, height: 100 }

    // 上方 37px、下方 27px —— 上方更大
    const upper = placeFloating(rect(45, 300, 200, 20), SIZE, 'bottom', small)
    expect(upper.placement).toBe('top')
    expect(upper.top).toBe(VIEWPORT_PAD)

    // 上方装不下（负空间）、下方 37px —— 下方更大
    const lower = placeFloating(rect(5, 300, 200, 20), SIZE, 'bottom', {
      width: 1000,
      height: 70,
    })
    expect(lower.placement).toBe('bottom')
    expect(lower.top).toBe(70 - 40 - VIEWPORT_PAD)
  })

  it('水平越界时夹紧到视口内', () => {
    const atLeft = placeFloating(rect(400, 0, 20, 20), SIZE, 'top', VIEWPORT)
    expect(atLeft.left).toBe(VIEWPORT_PAD)

    const atRight = placeFloating(rect(400, 990, 10, 20), SIZE, 'top', VIEWPORT)
    expect(atRight.left).toBe(VIEWPORT.width - SIZE.width - VIEWPORT_PAD)
  })

  it('浮层比视口还大时钉在起始边，而不是被推出视口', () => {
    const narrow: FloatingViewport = { width: 150, height: 800 }
    const pos = placeFloating(rect(400, 50, 20, 20), SIZE, 'top', narrow)

    expect(pos.left).toBe(VIEWPORT_PAD)
  })

  it('垂直方向同样受夹紧约束', () => {
    // 上方空间不足、下方又超出视口底部：翻下去也得夹回来
    const pos = placeFloating(rect(10, 300, 200, 20), SIZE, 'top', {
      width: 1000,
      height: 60,
    })

    expect(pos.top).toBe(60 - 40 - VIEWPORT_PAD)
  })
})
