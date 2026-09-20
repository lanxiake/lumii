import { describe, it, expect } from 'vitest'
import { computeAlignPlacements, type AlignFrame } from './align.js'

/** 造一帧：在 w×h 的不透明底（全透明）上画一个方块 */
function frame(name: string, w: number, h: number, block?: { x: number; y: number; w: number; h: number }): AlignFrame {
  const data = Buffer.alloc(w * h * 4)
  if (block) {
    for (let y = block.y; y < block.y + block.h; y++) {
      for (let x = block.x; x < block.x + block.w; x++) {
        const i = (y * w + x) * 4
        data[i] = 40
        data[i + 1] = 40
        data[i + 2] = 48
        data[i + 3] = 255
      }
    }
  }
  return { name, data, width: w, height: h }
}

describe('computeAlignPlacements — 地线对齐', () => {
  it('不同底边的帧对齐到同一条底线', () => {
    // A 的脚底在 y=30，B 在 y=50 → 对齐后两者包围盒底边相同
    const a = frame('a', 60, 60, { x: 20, y: 10, w: 20, h: 20 }) // 底边 29
    const b = frame('b', 60, 60, { x: 20, y: 30, w: 20, h: 20 }) // 底边 49
    const r = computeAlignPlacements([a, b], { baseline: 'bottom' })

    const pa = r.placements.find((p) => p.name === 'a')!
    const pb = r.placements.find((p) => p.name === 'b')!
    const bottomA = pa.y + (pa.bbox!.maxY)
    const bottomB = pb.y + (pb.bbox!.maxY)
    expect(bottomA).toBe(bottomB)
  })

  it('水平按包围盒中心对齐', () => {
    const a = frame('a', 100, 60, { x: 10, y: 10, w: 20, h: 20 }) // 中心 x=19.5
    const b = frame('b', 100, 60, { x: 60, y: 10, w: 20, h: 20 }) // 中心 x=69.5
    const r = computeAlignPlacements([a, b], { baseline: 'bottom' })

    const ca = r.placements.find((p) => p.name === 'a')!
    const cb = r.placements.find((p) => p.name === 'b')!
    const centerA = ca.x + (ca.bbox!.minX + ca.bbox!.maxX) / 2
    const centerB = cb.x + (cb.bbox!.minX + cb.bbox!.maxX) / 2
    expect(Math.abs(centerA - centerB)).toBeLessThanOrEqual(1)
  })

  it('全透明的帧不参与基准，也不把其他帧顶偏', () => {
    const a = frame('a', 60, 60, { x: 20, y: 10, w: 20, h: 20 })
    const b = frame('b', 60, 60, { x: 20, y: 30, w: 20, h: 20 })
    const withEmpty = computeAlignPlacements([a, b, frame('empty', 60, 60)], { baseline: 'bottom' })
    const withoutEmpty = computeAlignPlacements([a, b], { baseline: 'bottom' })

    expect(withEmpty.alignedCount).toBe(2)
    expect(withEmpty.placements).toHaveLength(3)
    // 基准不受影响：有效帧的落位与"没有空帧"时一致
    for (const name of ['a', 'b']) {
      const p1 = withEmpty.placements.find((p) => p.name === name)!
      const p2 = withoutEmpty.placements.find((p) => p.name === name)!
      expect([p1.x, p1.y]).toEqual([p2.x, p2.y])
    }
    // 空帧仍被摆进来（bbo​x 为 null），只是不影响别人
    expect(withEmpty.placements.find((p) => p.name === 'empty')!.bbox).toBeNull()
  })

  it('top / center 基准各按各的口径', () => {
    const a = frame('a', 60, 60, { x: 20, y: 10, w: 20, h: 10 })
    const b = frame('b', 60, 60, { x: 20, y: 30, w: 20, h: 10 })
    const top = computeAlignPlacements([a, b], { baseline: 'top' })
    const ta = top.placements.find((p) => p.name === 'a')!
    const tb = top.placements.find((p) => p.name === 'b')!
    expect(ta.y + ta.bbox!.minY).toBe(tb.y + tb.bbox!.minY)

    const center = computeAlignPlacements([a, b], { baseline: 'center' })
    const ca = center.placements.find((p) => p.name === 'a')!
    const cb = center.placements.find((p) => p.name === 'b')!
    const mA = ca.y + (ca.bbox!.minY + ca.bbox!.maxY) / 2
    const mB = cb.y + (cb.bbox!.minY + cb.bbox!.maxY) / 2
    expect(Math.abs(mA - mB)).toBeLessThanOrEqual(1)
  })

  it('落位全部非负，画布装得下所有帧', () => {
    const frames = [
      frame('a', 40, 40, { x: 0, y: 0, w: 10, h: 10 }),
      frame('b', 40, 40, { x: 30, y: 30, w: 10, h: 10 }),
    ]
    const r = computeAlignPlacements(frames, { baseline: 'bottom' })
    for (const p of r.placements) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.x + p.width).toBeLessThanOrEqual(r.canvas.w)
      expect(p.y + p.height).toBeLessThanOrEqual(r.canvas.h)
    }
  })

  it('horizontal=none 时内容保持原样，不做水平位移', () => {
    const a = frame('a', 100, 60, { x: 10, y: 10, w: 20, h: 20 })
    const b = frame('b', 100, 60, { x: 60, y: 10, w: 20, h: 20 })
    const r = computeAlignPlacements([a, b], { horizontal: 'none' })

    const ca = r.placements.find((p) => p.name === 'a')!
    // 帧的落位是 0（不位移），所以框内的内容还在自己的 x=10 处
    expect(ca.x).toBe(0)
    expect(ca.x + ca.bbox!.minX).toBe(10)
    const cb = r.placements.find((p) => p.name === 'b')!
    expect(cb.x + cb.bbox!.minX).toBe(60)
  })

  it('空输入不抛', () => {
    const r = computeAlignPlacements([])
    expect(r.placements).toEqual([])
    expect(r.canvas).toEqual({ w: 0, h: 0 })
  })
})

describe('基准取整的边界（实测踩过）', () => {
  it('一组中心一致的帧不做水平位移，画布不会平白宽 1 像素', () => {
    // 三帧内容完全相同、中心都是 23.5（minX=2, maxX=45）
    const mk = (n: string) => frame(n, 48, 56, { x: 2, y: 2, w: 44, h: 52 })
    const r = computeAlignPlacements([mk('a'), mk('b'), mk('c')], { baseline: 'bottom' })
    for (const p of r.placements) expect(p.x).toBe(0)
    // 公共画布不该因为取整而变宽
    expect(r.canvas.w).toBe(48)
  })
})
