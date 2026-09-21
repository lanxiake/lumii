import { describe, it, expect } from 'vitest'
import { computeAlignPlacements, computeNormalize, type AlignFrame } from './align.js'

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

describe('computeNormalize — 归一化到目标画布', () => {
  const rect = (n: string, w: number, h: number, block: { x: number; y: number; w: number; h: number }) =>
    frame(n, w, h, block)

  it('所有帧共用同一倍率（按最高的那格算）——逐帧撑满会让蹲下的帧被放大到站着一样高', () => {
    const tall = rect('tall', 200, 200, { x: 0, y: 0, w: 100, h: 100 })
    const short = rect('short', 200, 200, { x: 0, y: 0, w: 100, h: 50 })
    const r = computeNormalize([tall, short], { canvas: { w: 48, h: 56 }, anchor: [24, 54] })
    expect(r[0].scale).toBe(r[1].scale)
    // 缩放后「矮的那格」仍然矮一半，比例没被抹平
    expect(r[1].bbox!.h * r[1].scale).toBeCloseTo((r[0].bbox!.h * r[0].scale) / 2, 5)
  })

  it('包围盒底边落在锚点上（脚沾地）', () => {
    const f = rect('a', 200, 200, { x: 20, y: 30, w: 100, h: 90 })
    const r = computeNormalize([f], { canvas: { w: 48, h: 56 }, anchor: [24, 54] })
    const p = r[0]
    // 画布上的底边 = y + bbox.maxY * scale
    const bottom = p.y + p.bbox!.maxY * p.scale
    expect(Math.abs(bottom - 54)).toBeLessThanOrEqual(1)
  })

  it('包围盒水平中心落在锚点 x 上', () => {
    const f = rect('a', 200, 200, { x: 20, y: 30, w: 100, h: 90 })
    const r = computeNormalize([f], { canvas: { w: 48, h: 56 }, anchor: [24, 54] })
    const p = r[0]
    const center = p.x + ((p.bbox!.minX + p.bbox!.maxX) / 2) * p.scale
    expect(Math.abs(center - 24)).toBeLessThanOrEqual(1)
  })

  it('最高的那格缩放后正好占满 fit 比例的高度', () => {
    const f = rect('a', 200, 200, { x: 0, y: 0, w: 100, h: 100 })
    const r = computeNormalize([f], { canvas: { w: 48, h: 56 }, anchor: [24, 54], fit: 0.9 })
    expect(r[0].bbox!.h * r[0].scale).toBeCloseTo(56 * 0.9, 5)
  })

  it('全透明帧不参与"最高"的计算，但仍有落位', () => {
    const tall = rect('tall', 200, 200, { x: 0, y: 0, w: 100, h: 100 })
    const empty = frame('empty', 200, 200)
    const r = computeNormalize([tall, empty], { canvas: { w: 48, h: 56 }, anchor: [24, 54] })
    expect(r[1].bbox).toBeNull()
    expect(r[0].bbox!.h * r[0].scale).toBeCloseTo(56 * 0.94, 5) // 基准仍按"最高的有效帧"
    expect(Number.isFinite(r[1].x)).toBe(true)
  })

  it('空输入不抛', () => {
    expect(computeNormalize([], { canvas: { w: 48, h: 56 }, anchor: [24, 54] })).toEqual([])
  })

  /**
   * 回归防线：**不同批次切出来的格子尺寸不同，角色不能在跨批次时缩小**。
   *
   * 实测来由：同一只猫，单格批（1254 一格）里占 1191px 高，2×2 批（627 一格）里只占
   * 532px——模型都是「把角色填满格子」，格子小一半，角色就小一半。
   * 早先拿全体帧里最高的那个包围盒算一个全局倍率，于是 2×2 那批的角色只有
   * 单格批的 **45%** 大，切状态时宠物会突然缩小。
   *
   * 现在按帧尺寸分组、组内共享倍率：两组的角色都归一到目标高度。
   */
  it('不同帧尺寸的批次各自归一到同一目标高度（跨批次换网格不会缩水）', () => {
    // 大格：200×200 的格子里角色占 180 高；小格：100×100 的格子里角色占 90 高
    const big = rect('big', 200, 200, { x: 10, y: 10, w: 160, h: 180 })
    const small = rect('small', 100, 100, { x: 5, y: 5, w: 80, h: 90 })
    const r = computeNormalize([big, small], { canvas: { w: 48, h: 56 }, anchor: [24, 54] })

    expect(r[0].bbox!.h * r[0].scale).toBeCloseTo(56 * 0.94, 5)
    // 关键：小格里那个角色放大后**也是**目标高度，而不是它自己格子尺寸决定的 45%
    expect(r[1].bbox!.h * r[1].scale).toBeCloseTo(56 * 0.94, 5)
    expect(r[1].scale).toBeGreaterThan(r[0].scale)
  })

  it('同一组内仍共用一个倍率（蹲下的帧不会被单独撑满）', () => {
    const standing = rect('s', 200, 200, { x: 10, y: 10, w: 100, h: 180 })
    const crouching = rect('c', 200, 200, { x: 10, y: 110, w: 100, h: 80 })
    const r = computeNormalize([standing, crouching], { canvas: { w: 48, h: 56 }, anchor: [24, 54] })

    expect(r[0].scale).toBe(r[1].scale)
    // 蹲下的那帧矮，且没有被拉到和目标一样高
    expect(r[1].bbox!.h * r[1].scale).toBeLessThan(r[0].bbox!.h * r[0].scale)
  })
})
