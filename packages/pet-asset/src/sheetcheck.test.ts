/**
 * 出图闸门的单元测试
 *
 * 用合成的图集做夹具：真出图贵且不可复现，而这里要测的判据全部是几何/颜色题，
 * 合成夹具能把每一条判据**单独**逼出来（真图里它们总是同时成立或同时不成立）。
 */
import { describe, expect, it } from 'vitest'
import { analyzeSheet, SHEET_THRESHOLDS } from './sheetcheck.js'

const BG: [number, number, number] = [10, 240, 245]
const CHAR: [number, number, number] = [120, 90, 60]
const OUTLINE: [number, number, number] = [40, 28, 18]
/** 边界带里的近底色噪点：与 BG 的最大通道差 35，刚过 BLEED_TOL(30) */
const NOISE: [number, number, number] = [15, 205, 210]

interface Blob {
  /** 角色中心相对格心的偏移（像素） */
  dx?: number
  dy?: number
  /** 角色半径 */
  r?: number
  /**
   * 改画一条横贯整格的窄条（触到左右格线）。
   *
   * 用它而不是「超大的圆」来造越界：圆大到能顶穿格线时往往也盖住了边框带，
   * 于是 `estimateBackground` 的众数取到角色色、底色估错，整格的判据全部失真
   * （实测半径 66 在 128 格里占掉边框带 57%）。窄条只占边框带 3.6%，底色估计仍然正确，
   * 这样测到的才是「越界」本身。
   */
  bar?: boolean
}

/**
 * 造一张 cols×rows 的图集。每格一个圆角色，可按格微调位置与大小。
 * 返回 RGBA Buffer —— `analyzeSheet` 要的就是 4 通道（抠底读 alpha）。
 */
function makeSheet(
  cols: number,
  rows: number,
  cellSize: number,
  blobs: Blob[],
  opts: { divider?: boolean; noise?: number } = {},
): { data: Buffer; w: number; h: number } {
  const w = cols * cellSize
  const h = rows * cellSize
  const data = Buffer.alloc(w * h * 4)
  const put = (x: number, y: number, c: [number, number, number]): void => {
    const i = (y * w + x) * 4
    data[i] = c[0]
    data[i + 1] = c[1]
    data[i + 2] = c[2]
    data[i + 3] = 255
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, BG)

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const blob = blobs[r * cols + c] ?? {}
      const cx = c * cellSize + cellSize / 2 + (blob.dx ?? 0)
      const cy = r * cellSize + cellSize / 2 + (blob.dy ?? 0)
      const radius = blob.r ?? Math.floor(cellSize * 0.22)
      if (blob.bar) {
        const y0 = r * cellSize + Math.floor(cellSize / 2) - 4
        for (let y = y0; y < y0 + 8; y++) {
          for (let x = c * cellSize; x < (c + 1) * cellSize; x++) put(x, y, CHAR)
        }
        continue
      }
      for (let y = Math.max(0, cy - radius); y < Math.min(h, cy + radius); y++) {
        for (let x = Math.max(0, cx - radius); x < Math.min(w, cx + radius); x++) {
          const d = Math.hypot(x - cx, y - cy)
          if (d <= radius - 2) put(x, y, CHAR)
          else if (d <= radius) put(x, y, OUTLINE)
        }
      }
    }
  }

  if (opts.divider) {
    // 在格线上画一整条十字（实测 nano-banana-2 的行为）
    for (let k = 0; k < cols; k++) {
      const x = k * cellSize
      for (let y = 0; y < h; y++) put(x, y, OUTLINE)
    }
    for (let k = 0; k < rows; k++) {
      const y = k * cellSize
      for (let x = 0; x < w; x++) put(x, y, OUTLINE)
    }
  }

  if (opts.noise) {
    // 边界带里的零星近底色像素：与底色的最大通道差只有 35（刚过 BLEED_TOL=30），
    // 模拟实测撞上的「出图柔和渐变 + 压缩残差」，不是角色越界。
    for (let k = 0; k < opts.noise; k++) put(4 + k * 7, 1, NOISE)
  }
  return { data, w, h }
}

const run = (
  cols: number,
  rows: number,
  cell: number,
  blobs: Blob[],
  opts?: { divider?: boolean; noise?: number },
) => {
  const s = makeSheet(cols, rows, cell, blobs, opts)
  return analyzeSheet(s.data, s.w, s.h, { cols, rows })
}

describe('analyzeSheet / 网格', () => {
  it('尺寸能被网格整除时 divisible 为真', () => {
    expect(run(2, 2, 128, [{}, {}, {}, {}]).divisible).toBe(true)
  })

  it('除不尽时报 S0（实测 gpt-image 系列要 1024 却回 1254，1254 不能被 4 整除）', () => {
    const cell = 313 // 2×313 = 626 ≠ 627×2
    const s = makeSheet(2, 2, cell, [{}, {}, {}, {}])
    const r = analyzeSheet(s.data, s.w, s.h, { cols: 4, rows: 4 })
    expect(r.divisible).toBe(false)
    expect(r.problems.some((p) => p.startsWith('S0'))).toBe(true)
  })
})

describe('analyzeSheet / S1 边界干净', () => {
  it('角色完整落在格内时通过', () => {
    const r = run(2, 2, 128, [{}, {}, {}, {}])
    expect(r.s1).toBe(true)
    expect(r.cells.every((c) => c.bleed === 0)).toBe(true)
  })

  it('角色顶到格线时判越界，且**不**说成画了线', () => {
    // 格 128，半径 70 ⇒ 直径 140 > 128，圆会顶穿左右格线
    const r = run(2, 2, 128, [{ r: 70 }, {}, {}, {}])
    expect(r.s1).toBe(false)
    expect(r.cells[0]!.drewLine).toBe(false)
    expect(r.problems.some((p) => p.includes('越出格线'))).toBe(true)
  })

  /**
   * 这条是实测逼出来的：`nano-banana-2` 会在格线上画一整条十字，
   * 光数边界带的非底色像素**分不出**它和「角色越界」——而两者的处理方式完全不同。
   */
  it('模型在格线上画了线时，报「分隔线」而不是「角色越界」', () => {
    const r = run(2, 2, 128, [{}, {}, {}, {}], { divider: true })
    expect(r.s1).toBe(false)
    expect(r.cells.every((c) => c.drewLine)).toBe(true)
    const joined = r.problems.join('\n')
    expect(joined).toContain('分隔线')
    expect(joined).not.toContain('越出格线')
  })

  /**
   * 这条也是实测逼出来的：早先 S1 是 `bleed === 0`（一个像素都不许有），
   * 把一张**好图**判成了 unusable —— 1254×1254 的 2×2 出图，四格各只有 9 个像素
   * 落在边界带里，与青色底的最大通道差 31–36，肉眼完全看不出来。
   *
   * 判据改成比例（`MAX_BLEED_RATIO`）之后要同时守住两头：
   * 零星噪点放行、成片的越界照样拦。格 128 的边界带是 1500 个像素，0.5% = 7.5 个。
   */
  it('边界带里只有零星近底色噪点时**不**判越界', () => {
    const r = run(2, 2, 128, [{}, {}, {}, {}], { noise: 6 })
    expect(r.cells[0]!.bleed).toBe(6)
    expect(r.cells[0]!.bleedRatio).toBeLessThan(0.005)
    expect(r.s1).toBe(true)
    expect(r.problems.some((p) => p.includes('越出格线'))).toBe(false)
  })

  it('边界带里的非底色像素成片时仍判越界', () => {
    const r = run(2, 2, 128, [{}, {}, {}, {}], { noise: 40 })
    expect(r.cells[0]!.bleedRatio).toBeGreaterThan(0.005)
    expect(r.s1).toBe(false)
    expect(r.problems.some((p) => p.includes('越出格线'))).toBe(true)
  })
})

describe('analyzeSheet / S4 同一只角色', () => {
  it('各格配色一致时通过', () => {
    const r = run(2, 2, 128, [{}, {}, {}, {}])
    expect(r.s4).toBe(true)
    expect(r.minPaletteOverlap).toBeGreaterThan(0.99)
  })

  it('某一格换了个配色时判失败', () => {
    const s = makeSheet(2, 2, 128, [{}, {}, {}, {}])
    // 把第 3 格的角色改成纯蓝
    for (let y = 128; y < 256; y++) {
      for (let x = 0; x < 128; x++) {
        const i = (y * s.w + x) * 4
        if (s.data[i] === CHAR[0] && s.data[i + 1] === CHAR[1]) {
          s.data[i] = 30
          s.data[i + 1] = 60
          s.data[i + 2] = 230
        }
      }
    }
    const r = analyzeSheet(s.data, s.w, s.h, { cols: 2, rows: 2 })
    expect(r.s4).toBe(false)
    expect(r.problems.some((p) => p.startsWith('S4'))).toBe(true)
  })
})

describe('analyzeSheet / S6 连续性', () => {
  it('各格一模一样时判「没画出动作」（而不是静默通过）', () => {
    const r = run(2, 2, 128, [{}, {}, {}, {}])
    expect(r.s6).toBe(false)
    expect(r.baselineDiff).toBeLessThan(1)
    expect(r.problems.some((p) => p.includes('没有画出动作'))).toBe(true)
  })

  it('相邻差异适中、首尾相近时通过', () => {
    // 四格角色依次右移，首尾用同一个偏移 ⇒ 首尾差应当 ≈ 相邻差
    const r = run(2, 2, 128, [{ dx: -12 }, { dx: 0 }, { dx: 12 }, { dx: -12 }])
    expect(r.baselineDiff).toBeGreaterThan(1)
    expect(r.s6).toBe(true)
  })

  it('首尾接不上时判失败并给出两个数', () => {
    // 首格与末格差得远（末格大幅移位），中间三格小幅递进
    const r = run(2, 2, 128, [{ dx: 0 }, { dx: 4 }, { dx: 8 }, { dx: -40 }])
    expect(r.s6).toBe(false)
    expect(r.loopDiff).toBeGreaterThan(r.baselineDiff * SHEET_THRESHOLDS.loopRatio)
    expect(r.problems.some((p) => p.includes('首尾接不上'))).toBe(true)
  })
})

describe('analyzeSheet / S8 底色安全', () => {
  it('底色离角色色足够远时通过', () => {
    const r = run(2, 2, 128, [{}, {}, {}, {}])
    expect(r.s8).toBe(true)
  })

  it('底色与角色色接近时判失败（抠底会穿透描边）', () => {
    const s = makeSheet(2, 2, 128, [{}, {}, {}, {}])
    // 把底色换成接近描边的深棕
    for (let i = 0; i < s.data.length; i += 4) {
      if (s.data[i] === BG[0] && s.data[i + 1] === BG[1] && s.data[i + 2] === BG[2]) {
        s.data[i] = 52
        s.data[i + 1] = 40
        s.data[i + 2] = 30
      }
    }
    const r = analyzeSheet(s.data, s.w, s.h, { cols: 2, rows: 2 })
    expect(r.s8).toBe(false)
    expect(r.problems.some((p) => p.startsWith('S8'))).toBe(true)
  })
})

describe('analyzeSheet / 判定', () => {
  it('某一格没有角色时报「抠完没有任何内容」', () => {
    const r = run(2, 2, 128, [{ r: 0 }, {}, {}, {}])
    expect(r.cells[0]!.bbox).toBeNull()
    expect(r.problems.some((p) => p.includes('没有任何内容'))).toBe(true)
    expect(r.verdict).not.toBe('ok')
  })

  it('角色横贯整格、触到左右格线时，包围盒等于整格宽，判定不是 ok', () => {
    const r = run(2, 2, 128, [{ bar: true }, {}, {}, {}])
    expect(r.cells[0]!.bbox!.w).toBe(128)
    expect(r.cells[0]!.bleed).toBeGreaterThan(0)
    expect(r.cells[0]!.drewLine).toBe(false)
    expect(r.problems.some((p) => p.includes('越出格线'))).toBe(true)
    expect(r.verdict).not.toBe('ok')
  })

  /**
   * 底色是**逐格**估计的（取边框带众数）。角色盖住边框带时众数会变成角色色，
   * 之后所有判据都建立在错的底色上——这条备注就是用来把这种情况指出来的，
   * 否则它只会表现为「越界」这种看不出真因的失败。
   */
  it('某格底色估计被角色色顶替时，明确指出底色估计不可信', () => {
    const r = run(2, 2, 128, [{ r: 66 }, {}, {}, {}])
    expect(r.cells[0]!.background).not.toBe(r.cells[1]!.background)
    expect(r.problems.some((p) => p.includes('底色不一致'))).toBe(true)
  })

  it('干净且有动作的图集判 ok', () => {
    const r = run(2, 2, 128, [{ dy: -8 }, { dy: 0 }, { dy: 8 }, { dy: -8 }])
    expect(r.verdict).toBe('ok')
    expect(r.problems).toEqual([])
  })
})
