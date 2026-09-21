/**
 * 差分取层的单元测试
 */
import { describe, expect, it } from 'vitest'
import {
  DIFF_THRESHOLD,
  extractDiffLayer,
  MAX_DIFF_AREA_RATIO,
  MIN_DIFF_DENSITY,
} from './difflayer.js'

const W = 64
const H = 64
/** 背景透明、主体一块浅灰；用 alpha=255 的不透明像素，差分只看 RGB */
const BODY: [number, number, number] = [200, 190, 180]
const EYE: [number, number, number] = [20, 20, 20]
const OUTLINE_BLOCK: [number, number, number] = [40, 28, 18]

function blank(): Buffer {
  const b = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    b[i * 4] = BODY[0]
    b[i * 4 + 1] = BODY[1]
    b[i * 4 + 2] = BODY[2]
    b[i * 4 + 3] = 255
  }
  return b
}

function rect(b: Buffer, x0: number, y0: number, w: number, h: number, c: [number, number, number]): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4
      b[i] = c[0]
      b[i + 1] = c[1]
      b[i + 2] = c[2]
      b[i + 3] = 255
    }
  }
}

/** 某个像素在图层里是否不透明 */
const opaqueAt = (layer: Buffer, x: number, y: number): boolean => layer[(y * W + x) * 4 + 3] === 255

describe('extractDiffLayer', () => {
  it('两帧完全相同 ⇒ 无差异，usable=false', () => {
    const base = blank()
    const r = extractDiffLayer(blank(), base, W, H)
    expect(r.changed).toBe(0)
    expect(r.bbox).toBeNull()
    expect(r.bboxAreaRatio).toBeNull()
    expect(r.usable).toBe(false)
    expect(r.data.every((v) => v === 0)).toBe(true)
  })

  it('只有一小块变化 ⇒ 图层只在那一块不透明，其余全透明', () => {
    const base = blank()
    const frame = blank()
    rect(frame, 10, 12, 8, 4, EYE)

    const r = extractDiffLayer(frame, base, W, H)
    expect(r.changed).toBe(32)
    expect(r.bbox).toEqual({ minX: 10, minY: 12, maxX: 17, maxY: 15, w: 8, h: 4 })
    expect(r.usable).toBe(true)
    expect(opaqueAt(r.data, 12, 13)).toBe(true)
    expect(opaqueAt(r.data, 40, 40)).toBe(false)
    // 图层内容取自**表情帧**，不是基准帧
    const i = (13 * W + 12) * 4
    expect([r.data[i], r.data[i + 1], r.data[i + 2]]).toEqual(EYE)
  })

  /**
   * 这条是回归防线：早先的实现按**包围盒矩形**整块输出不透明像素，
   * 于是两块眼睛之间的脸也会被写成基准帧的样子——身体播到别的帧时那块会「冻住」，
   * 看起来像头被贴了一张图。扩张的必须是**掩膜**。
   */
  it('两块分离的变化之间保持透明（扩张的是掩膜，不是包围盒矩形）', () => {
    const base = blank()
    const frame = blank()
    rect(frame, 10, 10, 4, 4, EYE) // 左眼
    rect(frame, 40, 10, 4, 4, EYE) // 右眼

    const r = extractDiffLayer(frame, base, W, H, { dilate: 2 })
    // 包围盒横跨两眼
    expect(r.bbox!.minX).toBe(10)
    expect(r.bbox!.maxX).toBe(43)
    // 但两眼之间（比如 x=27）必须仍然透明
    expect(opaqueAt(r.data, 27, 11)).toBe(false)
    expect(opaqueAt(r.data, 11, 11)).toBe(true)
    expect(opaqueAt(r.data, 41, 11)).toBe(true)
  })

  it('扩张把变化区域向外放大一圈（盖住基准帧的抗锯齿边）', () => {
    const base = blank()
    const frame = blank()
    rect(frame, 20, 20, 4, 4, EYE)

    const tight = extractDiffLayer(frame, base, W, H, { dilate: 0 })
    expect(opaqueAt(tight.data, 19, 20)).toBe(false)
    expect(opaqueAt(tight.data, 24, 20)).toBe(false)

    const grown = extractDiffLayer(frame, base, W, H, { dilate: 2 })
    expect(opaqueAt(grown.data, 18, 20)).toBe(true)
    expect(opaqueAt(grown.data, 25, 20)).toBe(true)
    // 不该无限扩张
    expect(opaqueAt(grown.data, 30, 20)).toBe(false)
  })

  it('差异铺满大半张图 ⇒ 判对齐失败（usable=false）', () => {
    const base = blank()
    const frame = blank()
    // 盖住 80%×80% 的区域
    rect(frame, 6, 6, 52, 52, EYE)

    const r = extractDiffLayer(frame, base, W, H)
    expect(r.bboxAreaRatio!).toBeGreaterThan(MAX_DIFF_AREA_RATIO)
    expect(r.usable).toBe(false)
  })

  it('低于阈值的差异不算变化（否则压缩噪声会把整张脸判成变了）', () => {
    const base = blank()
    const frame = blank()
    const faint = DIFF_THRESHOLD - 1
    rect(frame, 30, 30, 4, 4, [BODY[0] - faint, BODY[1] - faint, BODY[2] - faint])
    expect(extractDiffLayer(frame, base, W, H).changed).toBe(0)
  })

  it('尺寸不符时抛错，而不是静默算出一堆错位的结果', () => {
    expect(() => extractDiffLayer(Buffer.alloc(4), blank(), W, H)).toThrow(/尺寸不符/)
  })
})

/**
 * 下面两组是**实测逼出来的**：两次独立的生成不可能逐像素一致，抗锯齿不可复现，
 * 描边周围会散落几百个孤立小差异。不过滤的话眼睛会被噪点淹没。
 */
describe('extractDiffLayer / 连通域过滤', () => {
  it('零星噪点被丢掉，成块的差异保留', () => {
    const base = blank()
    const frame = blank()
    rect(frame, 20, 20, 6, 5, EYE) // 「眼睛」：30 px 成块
    // 撒 30 个孤立噪点（各自 1px），模拟描边周围的抗锯齿差异
    for (let k = 0; k < 30; k++) {
      const x = 3 + k * 2
      const y = 52
      const i = (y * W + x) * 4
      frame[i] = 20
      frame[i + 1] = 20
      frame[i + 2] = 20
    }

    const r = extractDiffLayer(frame, base, W, H)
    expect(r.rawChanged).toBe(60)
    expect(r.changed).toBe(30) // 只剩眼睛
    expect(r.droppedPixels).toBe(30)
    expect(r.droppedComponents).toBe(30)
    expect(r.componentCount).toBe(1)
    expect(r.bbox).toEqual({ minX: 20, minY: 20, maxX: 25, maxY: 24, w: 6, h: 5 })
  })

  /**
   * 回归防线：密度早先按「总像素 ÷ 整体包围盒面积」算，**两只眼睛天然分得开**，
   * 中间那段空隙把密度拉到判据线下，于是一张抠得干干净净的脸被判成「散落一圈」。
   * 实测撞上过：两个各 21×20、紧致度 0.67 的连通域，整体算出来只有 0.47。
   */
  it('两只分开的眼睛仍判 usable（密度按连通域各算各的）', () => {
    const base = blank()
    const frame = blank()
    rect(frame, 8, 20, 6, 5, EYE)
    rect(frame, 50, 20, 6, 5, EYE)

    const r = extractDiffLayer(frame, base, W, H)
    expect(r.componentCount).toBe(2)
    // 整体包围盒横跨两眼 ⇒ 拿整体算密度会掉到 0.1 上下
    const globalDensity = r.changed / (r.bbox!.w * r.bbox!.h)
    expect(globalDensity).toBeLessThan(MIN_DIFF_DENSITY)
    // 但按连通域算就很高
    expect(r.density).toBeGreaterThan(MIN_DIFF_DENSITY)
    expect(r.usable).toBe(true)
  })
})

describe('extractDiffLayer / 平移补偿', () => {
  it('整体错开几个像素时能搜回来，补偿后差异归零', () => {
    const base = blank()
    rect(base, 20, 20, 10, 8, OUTLINE_BLOCK)
    // frame 的内容相对 base 右移 3、下移 2（纯平移，没有内容变化）
    const frame = blank()
    rect(frame, 23, 22, 10, 8, OUTLINE_BLOCK)

    const r = extractDiffLayer(frame, base, W, H)
    expect(r.offset).toEqual({ dx: 3, dy: 2 })
    expect(r.meanDiffAfter).toBeLessThan(r.meanDiffBefore)
    // 纯平移补偿干净之后，两帧应当**一模一样**，一点差异都不剩
    expect(r.changed).toBe(0)
    expect(r.bbox).toBeNull()
  })

  it('searchRadius=0 时不补偿，差异铺得更大', () => {
    const base = blank()
    rect(base, 20, 20, 10, 8, OUTLINE_BLOCK)
    const frame = blank()
    rect(frame, 23, 22, 10, 8, OUTLINE_BLOCK)

    const noSearch = extractDiffLayer(frame, base, W, H, { searchRadius: 0 })
    expect(noSearch.offset).toEqual({ dx: 0, dy: 0 })
    // 没补偿 ⇒ 差异是两个错开方块的**对称差**（80+80−2×42=76），且都留下
    expect(noSearch.changed).toBe(76)
    expect(extractDiffLayer(frame, base, W, H).changed).toBe(0)
  })
})
