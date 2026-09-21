import { describe, it, expect } from 'vitest'
import { pointInPolygon } from '@mtbot/pet-core'
import { deriveHitAreas, type DerivedHitArea } from './hit-areas.js'

/**
 * 在 w×h 的全透明画布上涂若干矩形。
 * 矩形按给定顺序叠加（后面的盖前面的）。
 */
function canvas(w: number, h: number, boxes: { x: number; y: number; w: number; h: number }[]) {
  const data = Buffer.alloc(w * h * 4)
  for (const b of boxes) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = (y * w + x) * 4
        data[i] = 30
        data[i + 1] = 30
        data[i + 2] = 40
        data[i + 3] = 255
      }
    }
  }
  return data
}

const find = (areas: DerivedHitArea[], id: string) => areas.find((a) => a.id === id)

/**
 * 上窄下宽的梯形（逐行绘制）。
 * 左右边界**每行都在变**，所以竖直压缩压不掉——用来验「行数越多越贴合」。
 */
function wedge(w: number, h: number, topW: number, bottomW: number): Buffer {
  const data = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    const width = Math.round(topW + ((bottomW - topW) * y) / (h - 1))
    const x0 = Math.round((w - width) / 2)
    for (let x = x0; x < x0 + width; x++) {
      const i = (y * w + x) * 4
      data[i] = 30
      data[i + 1] = 30
      data[i + 2] = 40
      data[i + 3] = 255
    }
  }
  return data
}

/** 一个「头窄身宽」的人形：头 y10..29 宽 20，身 y30..79 宽 40 */
const HUMANOID = [
  { x: 40, y: 10, w: 20, h: 20 },
  { x: 30, y: 30, w: 40, h: 50 },
]

describe('deriveHitAreas — 基本结构', () => {
  it('产出头与身体两个命中区，id 与注册表 tapMotions 的约定一致', () => {
    const areas = deriveHitAreas(canvas(100, 100, HUMANOID), 100, 100)
    expect(areas.map((a) => a.id)).toEqual(['HitAreaBody', 'HitAreaHead'])
  })

  it('身体在下、头在上，**分界处严丝合缝**（不留点不到的缝）', () => {
    const areas = deriveHitAreas(canvas(100, 100, HUMANOID), 100, 100)
    const head = find(areas, 'HitAreaHead')!
    const body = find(areas, 'HitAreaBody')!
    const maxY = (a: DerivedHitArea) => Math.max(...a.points.map((p) => p[1]))
    const minY = (a: DerivedHitArea) => Math.min(...a.points.map((p) => p[1]))
    // 取中点当采样点时这里是 `maxY(head) < minY(body)`——中间空出十几像素谁也点不到
    expect(maxY(head)).toBe(minY(body))
  })

  it('每个命中区至少 3 个顶点，且都是整数（顶点要进 JSON）', () => {
    const areas = deriveHitAreas(canvas(100, 100, HUMANOID), 100, 100)
    for (const a of areas) {
      expect(a.points.length).toBeGreaterThanOrEqual(3)
      for (const [x, y] of a.points) {
        expect(Number.isInteger(x)).toBe(true)
        expect(Number.isInteger(y)).toBe(true)
      }
    }
  })

  it('全透明画布不产出任何命中区', () => {
    expect(deriveHitAreas(Buffer.alloc(100 * 100 * 4), 100, 100)).toEqual([])
  })
})

describe('deriveHitAreas — 贴着轮廓而不是包围盒', () => {
  /**
   * 这是本模块存在的理由：包围盒会把「抬手」旁边那一大片空白圈进去，
   * 而 `isPointerOverModel` 先用 hitTest——空白被命中就意味着鼠标在宠物
   * 旁边的透明区被吃掉、穿不到下层窗口。
   */
  it('窄的那一段，旁边空白不算命中', () => {
    const areas = deriveHitAreas(canvas(100, 100, HUMANOID), 100, 100)
    const head = find(areas, 'HitAreaHead')!
    // 头顶那一带角色只有 x40..59，x=25 在包围盒内但在轮廓外
    expect(pointInPolygon(25, 12, head.points)).toBe(false)
    expect(pointInPolygon(45, 12, head.points)).toBe(true)
  })

  it('宽的那一段，多出来的部分算命中', () => {
    const areas = deriveHitAreas(canvas(100, 100, HUMANOID), 100, 100)
    const body = find(areas, 'HitAreaBody')!
    expect(pointInPolygon(35, 70, body.points)).toBe(true)
    expect(pointInPolygon(25, 70, body.points)).toBe(false)
  })

  it('弯曲的轮廓随采样行数变细', () => {
    const data = wedge(100, 100, 20, 60)
    const coarse = find(deriveHitAreas(data, 100, 100, { rows: 6 }), 'HitAreaHead')!
    const fine = find(deriveHitAreas(data, 100, 100, { rows: 30 }), 'HitAreaHead')!
    expect(fine.points.length).toBeGreaterThan(coarse.points.length)
  })

  /**
   * 竖直的边只需要两个端点——逐行采样会在那里堆一串 x 相同的点。
   * 压掉它们之后，**行数可以放心调高**（弯曲处更贴合）而顶点数不涨。
   */
  it('竖直的边被压成两个端点，与采样行数无关', () => {
    const data = canvas(100, 100, [{ x: 30, y: 10, w: 40, h: 80 }])
    const coarse = find(deriveHitAreas(data, 100, 100, { rows: 8 }), 'HitAreaHead')!
    const fine = find(deriveHitAreas(data, 100, 100, { rows: 48 }), 'HitAreaHead')!
    expect(fine.points.length).toBe(coarse.points.length)
    // 一个矩形就是 4 个角；两条边各 2 个端点
    expect(coarse.points.length).toBeLessThanOrEqual(4)
  })
})

describe('deriveHitAreas — 分界与鲁棒性', () => {
  it('headRatio 决定分界高度', () => {
    const data = canvas(100, 100, HUMANOID)
    const maxY = (a: DerivedHitArea) => Math.max(...a.points.map((p) => p[1]))
    const low = find(deriveHitAreas(data, 100, 100, { headRatio: 0.2 }), 'HitAreaHead')!
    const high = find(deriveHitAreas(data, 100, 100, { headRatio: 0.6 }), 'HitAreaHead')!
    expect(maxY(high)).toBeGreaterThan(maxY(low))
  })

  it('headRatio 越界时被夹住，而不是产出退化的区', () => {
    const data = canvas(100, 100, HUMANOID)
    for (const r of [0, -1, 5, 99]) {
      const areas = deriveHitAreas(data, 100, 100, { headRatio: r })
      expect(areas.map((a) => a.id).sort()).toEqual(['HitAreaBody', 'HitAreaHead'])
    }
  })

  /**
   * 中间有一整行全透明（如身体被腰带切断的画法）。
   * 空行若不回填，多边形会在那里收成尖角；相邻行一旦左右交叉，多边形自交，
   * 射线法的奇偶判定就会在部分区域反过来。
   */
  it('带子里有空行时仍然闭合、不自交', () => {
    const data = canvas(100, 100, [
      { x: 40, y: 10, w: 20, h: 20 },
      { x: 30, y: 30, w: 40, h: 20 },
      // y50..59 留空
      { x: 30, y: 60, w: 40, h: 20 },
    ])
    const body = find(deriveHitAreas(data, 100, 100), 'HitAreaBody')!
    // 空行按上一行的宽度沿用 ⇒ 空行处依然算命中
    expect(pointInPolygon(50, 55, body.points)).toBe(true)
    // 而轮廓外面仍然不算
    expect(pointInPolygon(10, 55, body.points)).toBe(false)
  })

  it('只有一行高的角色不会产出退化多边形', () => {
    const data = canvas(100, 100, [{ x: 20, y: 50, w: 60, h: 1 }])
    // 至少 3 个不同顶点才算数；这条形状即使产出也必须合法
    for (const a of deriveHitAreas(data, 100, 100)) {
      expect(new Set(a.points.map((p) => p.join(','))).size).toBeGreaterThanOrEqual(3)
    }
  })

  it('id 可改（不同注册表用不同约定时）', () => {
    const areas = deriveHitAreas(canvas(100, 100, HUMANOID), 100, 100, {
      headId: 'Head',
      bodyId: 'Body',
    })
    expect(areas.map((a) => a.id)).toEqual(['Body', 'Head'])
  })

  /**
   * 轮廓包围盒的最上一行/最下一行是轮廓**收成尖**的地方——樱桃待机帧的 y=441
   * 整行只有 5 个不透明像素，而 y=432 有 44 个。只按那一行取样，多边形就会从
   * 上一采样点直接连到这个近退化的尖点，**中间几行全被直线切掉**
   * （实测 y=439 有 70% 的角色像素点不到）。
   *
   * 现在首尾各取半格窗口的并集。这条测试换成上宽下窄的梯形来守它。
   */
  it('末端收尖时，最后几行仍然覆盖得住', () => {
    const data = wedge(100, 100, 80, 2)
    const areas = deriveHitAreas(data, 100, 100, { rows: 8 })
    const body = find(areas, 'HitAreaBody')!
    const maxY = Math.max(...body.points.map((p) => p[1]))

    let total = 0
    let covered = 0
    for (let y = maxY - 4; y <= maxY; y++) {
      for (let x = 0; x < 100; x++) {
        if (data[(y * 100 + x) * 4 + 3]! <= 128) continue
        total++
        if (areas.some((a) => pointInPolygon(x, y, a.points))) covered++
      }
    }
    // 真实素材上，改之前樱桃待机帧底部那几行的覆盖率是 30%（y=439 漏 28/40px）
    expect(covered / total).toBeGreaterThan(0.9)
  })
})
