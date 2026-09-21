import { describe, it, expect } from 'vitest'
import {
  alphaBBox,
  colorDistance,
  cutout,
  distanceField,
  estimateBackground,
  floodOutside,
  formatHexColor,
  parseHexColor,
  tuneSolid,
  unpremultiply,
  type RGB,
} from './cutout.js'

const MAGENTA: RGB = [217, 33, 143]
const INK: RGB = [40, 40, 48]

/**
 * 造一张测试图：不透明底色 + 居中方块。
 * 布局与验证点 A 的夹具同构（底色远离前景），便于复用那边的结论。
 */
function makeImage(w: number, h: number, block: { x: number; y: number; w: number; h: number }, bg: RGB = MAGENTA, fg: RGB = INK) {
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const inBlock = x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h
      const c = inBlock ? fg : bg
      buf[i] = c[0]
      buf[i + 1] = c[1]
      buf[i + 2] = c[2]
      buf[i + 3] = 255
    }
  }
  return buf
}

const alphaAt = (buf: Buffer, w: number, x: number, y: number) => buf[(y * w + x) * 4 + 3]

describe('colorDistance', () => {
  it('同色为 0', () => {
    expect(colorDistance(MAGENTA, MAGENTA)).toBe(0)
  })
  it('欧氏距离', () => {
    expect(colorDistance([0, 0, 0], [3, 4, 0])).toBe(5)
  })
})

describe('unpremultiply', () => {
  it('完全透明返回黑', () => {
    expect(unpremultiply([10, 20, 30], 0, MAGENTA, INK)).toEqual([0, 0, 0])
  })
  it('完全不透明原样返回', () => {
    expect(unpremultiply([10, 20, 30], 1, MAGENTA, INK)).toEqual([10, 20, 30])
  })
  it('半透明按 C = a·F + (1−a)·B 反解出 F', () => {
    const F: RGB = [100, 150, 200]
    const a = 0.5
    const C: RGB = [0, 1, 2].map((k) => Math.round(a * F[k] + (1 - a) * MAGENTA[k])) as RGB
    const out = unpremultiply(C, a, MAGENTA, F)
    for (let k = 0; k < 3; k++) expect(Math.abs(out[k] - F[k])).toBeLessThanOrEqual(2)
  })
  it('低 alpha 区改用参考前景色（避免除以接近 0 的数把误差放大）', () => {
    // a=0.02 落在稳定化窗口以下，应当直接给出参考色
    expect(unpremultiply([200, 10, 120], 0.02, MAGENTA, INK)).toEqual(INK)
  })
})

describe('floodOutside', () => {
  it('只填充与边界连通的底色区，被前景包住的同色区不填充', () => {
    const w = 20
    const h = 20
    // 前景方块中间挖一个底色小孔：它不与边界连通，不应被填充
    const rgba = makeImage(w, h, { x: 4, y: 4, w: 12, h: 12 })
    for (let y = 9; y < 11; y++) {
      for (let x = 9; x < 11; x++) {
        const i = (y * w + x) * 4
        rgba[i] = MAGENTA[0]
        rgba[i + 1] = MAGENTA[1]
        rgba[i + 2] = MAGENTA[2]
      }
    }
    const d = distanceField(rgba, w, h, MAGENTA)
    const outside = floodOutside(d, w, h, 25)

    expect(outside[0]).toBe(1) // 左上角是背景
    expect(outside[9 * w + 9]).toBe(0) // 被包住的孔不被填充
    expect(outside[8 * w + 8]).toBe(0) // 前景方块内部也不被填充
  })
})

describe('tuneSolid', () => {
  it('在穿透描边前停住（容差必须小于描边色距底色的距离）', () => {
    const w = 64
    const h = 64
    const rgba = makeImage(w, h, { x: 16, y: 16, w: 32, h: 32 })
    const outlineDistance = colorDistance(INK, MAGENTA)
    const tuning = tuneSolid(rgba, w, h, MAGENTA)
    expect(tuning.tSolid).toBeLessThan(outlineDistance)
    expect(tuning.leakAt).not.toBeNull()
  })

  it('底色与前景完全一致时立即判为泄漏（无从下手）', () => {
    const w = 32
    const h = 32
    const flat = makeImage(w, h, { x: 8, y: 8, w: 16, h: 16 }, MAGENTA, MAGENTA)
    const tuning = tuneSolid(flat, w, h, MAGENTA)
    expect(tuning.leakAt).toBeLessThanOrEqual(20)
  })
})

describe('cutout', () => {
  it('底色变透明，前景保持不透明且颜色不失真', () => {
    const w = 64
    const h = 64
    const rgba = makeImage(w, h, { x: 16, y: 16, w: 32, h: 32 })
    const r = cutout(rgba, w, h, MAGENTA)

    expect(alphaAt(r.data, w, 0, 0)).toBe(0)
    expect(alphaAt(r.data, w, 32, 32)).toBe(255)
    const i = (32 * w + 32) * 4
    expect(Math.abs(r.data[i] - INK[0])).toBeLessThanOrEqual(2)
    expect(Math.abs(r.data[i + 1] - INK[1])).toBeLessThanOrEqual(2)
    expect(Math.abs(r.data[i + 2] - INK[2])).toBeLessThanOrEqual(2)
  })

  it('被前景包住的近底色区保留为不透明（连通性抠底的核心价值）', () => {
    const w = 64
    const h = 64
    const rgba = makeImage(w, h, { x: 16, y: 16, w: 32, h: 32 })
    // 陷阱色：离底色 40 —— 必须**大于 tLow(25)**。等于底色时会被 tLow 规则直接判透明，
    // 那正是设计里那条硬约束的由来（底色必须远离角色所有颜色，见 §7 风险表）。
    const trap: RGB = [MAGENTA[0] - 40, MAGENTA[1], MAGENTA[2]]
    const hole = { x: 30, y: 30, w: 4, h: 4 }
    for (let y = hole.y; y < hole.y + hole.h; y++) {
      for (let x = hole.x; x < hole.x + hole.w; x++) {
        const i = (y * w + x) * 4
        rgba[i] = trap[0]
        rgba[i + 1] = trap[1]
        rgba[i + 2] = trap[2]
      }
    }
    const r = cutout(rgba, w, h, MAGENTA)
    expect(alphaAt(r.data, w, 32, 32)).toBe(255)
  })

  it('显式 tSolid 时不走自动调参', () => {
    const w = 32
    const h = 32
    const rgba = makeImage(w, h, { x: 8, y: 8, w: 16, h: 16 })
    const r = cutout(rgba, w, h, MAGENTA, { tSolid: 15 })
    expect(r.tuning.tSolid).toBe(15)
    expect(r.tuning.leakAt).toBeNull()
  })

  it('tLow 以内的像素直接判透明', () => {
    const w = 16
    const h = 16
    const rgba = makeImage(w, h, { x: 4, y: 4, w: 8, h: 8 })
    // 把左上角染成离底色 10 的近似色
    const i = 0
    rgba[i] = MAGENTA[0] + 10
    rgba[i + 1] = MAGENTA[1]
    rgba[i + 2] = MAGENTA[2]
    const r = cutout(rgba, w, h, MAGENTA, { tLow: 25 })
    expect(r.data[3]).toBe(0)
  })
})

describe('estimateBackground', () => {
  it('取边框带众数', () => {
    const rgba = makeImage(200, 200, { x: 60, y: 60, w: 80, h: 80 })
    expect(estimateBackground(rgba, 200, 200)).toEqual(MAGENTA)
  })

  it('小图上采样带被夹薄 —— 否则众数会选到角色自身颜色', () => {
    // 96×32 的精灵表切片，角色占 69%。固定 24px 的采样带在 h=32 的图上会盖住**每一个**
    // 像素（y<24 || y>=8 恒真），众数于是选到角色色；夹到 min(w,h)/8=4 后只剩边框带，
    // 那里全是底色。
    const w = 96
    const h = 32
    const rgba = makeImage(w, h, { x: 4, y: 4, w: 88, h: 24 })
    const inkCount = 88 * 24
    expect(inkCount).toBeGreaterThan(w * h - inkCount) // 前提：角色确实占多数
    expect(estimateBackground(rgba, w, h)).toEqual(MAGENTA)
  })

  it('采样带仍随图变大而还原到 24px（大图行为与已验证实现一致）', () => {
    const rgba = makeImage(1024, 1024, { x: 100, y: 100, w: 800, h: 800 })
    expect(estimateBackground(rgba, 1024, 1024)).toEqual(MAGENTA)
  })
})

describe('alphaBBox', () => {
  it('给出不透明区域包围盒', () => {
    const w = 64
    const h = 64
    const rgba = makeImage(w, h, { x: 16, y: 20, w: 10, h: 8 })
    const r = cutout(rgba, w, h, MAGENTA)
    expect(alphaBBox(r.data, w, h)).toEqual({ minX: 16, minY: 20, maxX: 25, maxY: 27, w: 10, h: 8 })
  })

  it('全透明返回 null', () => {
    expect(alphaBBox(Buffer.alloc(16 * 16 * 4), 16, 16)).toBeNull()
  })

  /**
   * 回归防线：默认阈值必须是 128。
   *
   * 实测来由：`girl-idle` 那批出图（1254×1254 的 2×2）里，背景的**四个角**各有一粒
   * alpha 21/23/25 的像素——肉眼不可见，是背景渐变与压缩残差。用 16 去量，
   * 包围盒从 188 宽被撑到 **408** 宽（那几粒噪声落在格子最外沿），
   * 而包围盒是 S1/S2 判据与整个归一化落位的输入。
   *
   * 这条用例直接构造那个形状：角色一块，角落里一粒 alpha≈0.1 的雾。
   */
  it('角落里的一粒半透明雾不参与包围盒（默认阈值 128，不是 16）', () => {
    const w = 64
    const h = 64
    const rgba = makeImage(w, h, { x: 16, y: 20, w: 10, h: 8 })
    const r = cutout(rgba, w, h, MAGENTA)
    // 把右下角那粒像素写成「离底色只差一点」的雾：抠底会判它 alpha ≈ 0.1
    const i = ((h - 1) * w + (w - 1)) * 4
    const bg = estimateBackground(rgba, w, h)
    r.data[i] = bg[0] - 26
    r.data[i + 1] = bg[1] - 26
    r.data[i + 2] = bg[2] - 26
    r.data[i + 3] = 26

    // 雾在包围盒外——16 会把 (63,63) 算进来，128 不会
    expect(alphaBBox(r.data, w, h, 16)!.maxX).toBe(w - 1)
    expect(alphaBBox(r.data, w, h)).toEqual({ minX: 16, minY: 20, maxX: 25, maxY: 27, w: 10, h: 8 })
  })
})

describe('parseHexColor / formatHexColor', () => {
  it('解析 #rrggbb 与 rrggbb', () => {
    expect(parseHexColor('#d9218f')).toEqual(MAGENTA)
    expect(parseHexColor('d9218f')).toEqual(MAGENTA)
    expect(parseHexColor('  #D9218F  ')).toEqual(MAGENTA)
  })
  it('非法输入返回 null', () => {
    for (const bad of ['', '#fff', '#gggggg', 'red', '#d9218f00']) {
      expect(parseHexColor(bad), bad).toBeNull()
    }
  })
  it('格式化补零', () => {
    expect(formatHexColor([0, 8, 255])).toBe('#0008ff')
    expect(formatHexColor(MAGENTA)).toBe('#d9218f')
  })
})
