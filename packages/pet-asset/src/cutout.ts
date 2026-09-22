/**
 * cutout — 连通性抠底（自 verify/pet-sprite/lib/cutout.mjs 沉淀，算法未改）
 *
 * 算法要点（两处关键均由验证点 A 的实测逼出来，详见 docs/test/pet-sprite/验证报告.md）：
 *
 * 1. **alpha 用相对距离归一化**：`a = d(C,B) / d(F_最近前景, B)`。
 *    因为 `C = a·F + (1−a)·B` 时 `d(C,B) = a·d(F,B)` 精确成立，
 *    除以最近前景色的距离即可还原真实 a。用固定阈值当分母会失真 ——
 *    不同部位前景色距底色各不相同（实测 154 / 189 / 251）。
 *
 * 2. **连通性区分「背景」与「被包住的同色区」**：从图像边界 flood fill，
 *    被描边包住的部位（如内耳）不会被填充到，因而得以保留。
 *    纯距离阈值法在这里**结构性失败**：与底色接近的前景部位，和 alpha 恰好相等的
 *    抗锯齿边缘像素，在距离维度上完全不可区分。
 *
 * **硬约束**：flood fill 容差 `tSolid` 必须**小于描边色距底色的距离**。
 * 超过时 flood fill 会穿过描边漏进角色内部，把前景一并当背景（实测误差暴涨 300 倍）。
 * 真实素材不知道描边距离，故提供 `tuneSolid()` 自动调参。
 */

export type RGB = [number, number, number]

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
  w: number
  h: number
}

export interface SolidTuning {
  /** 选中的容差 */
  tSolid: number
  /** 首次检出泄漏的容差；未泄漏为 null */
  leakAt: number | null
  /** 泄漏时（或扫完时）的连通背景占比 */
  leakRatio: number
}

export interface CutoutOptions {
  /** 距离 ≤ tLow 直接判透明（应覆盖底色噪声上限） */
  tLow?: number
  /** flood fill 容差；省略时自动调参 */
  tSolid?: number
}

export interface CutoutResult {
  data: Buffer
  tuning: SolidTuning
  opaqueCount: number
  semiCount: number
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

/** 低 alpha 反预乘的稳定化窗口：低于 LO 处改用参考前景色，避免除以接近 0 的数 */
const STAB_LO = 0.05
const STAB_HI = 0.2

export const colorDistance = (a: RGB, b: RGB): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * 反预乘 + 低 alpha 稳定化。
 *
 * F = (C − (1−a)·B) / a 在 a→0 时把输入误差放大数十倍；
 * 而这些像素对最终画面的贡献与 a 成正比（近乎不可见），故低 alpha 区改用参考前景色。
 */
export function unpremultiply(C: RGB, a: number, B: RGB, ref: RGB): RGB {
  if (a <= 0) return [0, 0, 0]
  if (a >= 1) return C
  const un: RGB = [0, 1, 2].map((k) => clamp255((C[k] - (1 - a) * B[k]) / a)) as RGB
  const w = clamp01((a - STAB_LO) / (STAB_HI - STAB_LO))
  return [0, 1, 2].map((k) => Math.round(w * un[k] + (1 - w) * ref[k])) as RGB
}

/** 距离场：每个像素到背景色的欧氏距离 */
export function distanceField(rgba: Buffer, w: number, h: number, B: RGB): Float32Array {
  const N = w * h
  const d = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    d[i] = Math.hypot(rgba[i * 4] - B[0], rgba[i * 4 + 1] - B[1], rgba[i * 4 + 2] - B[2])
  }
  return d
}

/** 从图像四边 flood fill，标记「与边界连通的背景区」 */
export function floodOutside(d: Float32Array, w: number, h: number, tSolid: number): Uint8Array {
  const N = w * h
  const outside = new Uint8Array(N)
  const stack: number[] = []
  const push = (i: number) => {
    if (outside[i] === 0 && d[i] <= tSolid) {
      outside[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  while (stack.length) {
    const i = stack.pop() as number
    const x = i % w
    const y = (i / w) | 0
    if (x > 0) push(i - 1)
    if (x < w - 1) push(i + 1)
    if (y > 0) push(i - w)
    if (y < h - 1) push(i + w)
  }
  return outside
}

/**
 * 自动挑选 flood fill 容差。
 *
 * 原理：容差未超过描边距离时，「连通背景区」占比 ≈ 真实背景占比；
 * 一旦超过，flood fill 会穿过描边漏进角色内部，占比**突增**到接近全图。
 * 故取「占比突增前的最大容差」。
 */
export function tuneSolid(
  rgba: Buffer,
  w: number,
  h: number,
  B: RGB,
  { maxSolid = 254, leakRatio = 0.9, steps = 24 } = {},
): SolidTuning {
  const d = distanceField(rgba, w, h, B)
  const N = w * h
  let best = Math.round(maxSolid * 0.5)
  let prevRatio = 0

  for (let s = 1; s <= steps; s++) {
    const t = Math.round((s / steps) * maxSolid)
    const outside = floodOutside(d, w, h, t)
    let cnt = 0
    for (let i = 0; i < N; i++) if (outside[i]) cnt++
    const ratio = cnt / N
    if (ratio > leakRatio) {
      best = Math.max(1, Math.round(((s - 1) / steps) * maxSolid))
      return { tSolid: best, leakAt: t, leakRatio: ratio }
    }
    prevRatio = ratio
    best = t
  }
  return { tSolid: best, leakAt: null, leakRatio: prevRatio }
}

/**
 * 抠底主函数。
 *
 * @param rgba 不透明 RGBA 像素
 * @param B 背景色 RGB
 */
export function cutout(
  rgba: Buffer,
  w: number,
  h: number,
  B: RGB,
  { tLow = 25, tSolid }: CutoutOptions = {},
): CutoutResult {
  const N = w * h
  const tuning: SolidTuning =
    tSolid === undefined
      ? tuneSolid(rgba, w, h, B)
      : { tSolid, leakAt: null, leakRatio: 0 }
  const tS = tSolid ?? tuning.tSolid

  const d = distanceField(rgba, w, h, B)
  const outside = floodOutside(d, w, h, tS)

  // 实心种子 = 未被填充到、且不贴底色（角色内部 + 被包住的部位）
  const solid = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (!outside[i] && d[i] > tLow) solid[i] = 1

  // 多源 BFS：把实心种子的颜色传播给所有非实心像素，作为「最近前景色」参考
  const refR = new Uint8Array(N)
  const refG = new Uint8Array(N)
  const refB = new Uint8Array(N)
  const seen = new Uint8Array(N)
  const q: number[] = []
  for (let i = 0; i < N; i++) {
    if (solid[i]) {
      seen[i] = 1
      refR[i] = rgba[i * 4]
      refG[i] = rgba[i * 4 + 1]
      refB[i] = rgba[i * 4 + 2]
      q.push(i)
    }
  }
  for (let head = 0; head < q.length; head++) {
    const i = q[head]
    const x = i % w
    const y = (i / w) | 0
    const go = (j: number) => {
      if (seen[j]) return
      seen[j] = 1
      refR[j] = refR[i]
      refG[j] = refG[i]
      refB[j] = refB[i]
      q.push(j)
    }
    if (x > 0) go(i - 1)
    if (x < w - 1) go(i + 1)
    if (y > 0) go(i - w)
    if (y < h - 1) go(i + w)
  }

  const out = Buffer.alloc(N * 4)
  let opaqueCount = 0
  let semiCount = 0
  for (let i = 0; i < N; i++) {
    const C: RGB = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]
    let a: number
    if (d[i] <= tLow) a = 0
    else if (!outside[i]) a = 1
    else {
      const F: RGB = [refR[i], refG[i], refB[i]]
      const dRef = Math.hypot(F[0] - B[0], F[1] - B[1], F[2] - B[2])
      a = dRef < 1 ? 0 : clamp01(d[i] / dRef)
    }
    if (a >= 0.999) opaqueCount++
    else if (a > 0.001) semiCount++

    const F = unpremultiply(C, a, B, [refR[i], refG[i], refB[i]])
    out[i * 4] = F[0]
    out[i * 4 + 1] = F[1]
    out[i * 4 + 2] = F[2]
    out[i * 4 + 3] = Math.round(a * 255)
  }

  return { data: out, tuning: { ...tuning, tSolid: tS }, opaqueCount, semiCount }
}

/**
 * alpha > 阈值的像素包围盒。
 *
 * 默认取 **128**（半透明以上才算），不是 16。这条是实测量出来的：
 * 真实出图抠底后，背景里会散落极少数 alpha 十几到二十几的像素——**整张图里三五个**，
 * 位置常在格子的四角（背景渐变最远处）。它们肉眼不可见，却足以把包围盒从
 * 188 宽撑到 408 宽（实测 `girl-idle` 那批：四个角像素的 alpha 是 21/23/25）。
 *
 * 用 16 去量，包围盒量到的就不是角色，而是「离底色最远的那粒噪声」。
 * `computeNormalize` 早就因此单独用了 128（见 `NormalizeOptions.bboxThreshold` 的来由），
 * 这里把默认值对齐过去——**同一个问题不该在两个地方有两个答案**。
 */
export function alphaBBox(buf: Buffer, w: number, h: number, thr = 128): BBox | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (buf[(y * w + x) * 4 + 3] > thr) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * 不透明像素的水平**质量重心**（阈值以上的像素取等权平均）；全透明返回 null。
 *
 * 与 `alphaBBox` 是**两个不同的统计量，不能互相替代**：包围盒是**极值**统计
 * （被最左/最右那一个像素钉住），重心是**质量**统计。拿包围盒中心做水平对齐时，
 * 只要角色身上有一个位置固定的极值点（耳朵尖、尾巴梢、拖地的影子），
 * 包围盒就被钉住不动，而**身体在里面左右摇**。
 *
 * 实测（2026-09-22，团子的 384×448 待机 8 帧）：包围盒中心帧间极差 **1.0px**
 * （看着像已经对齐好了），重心极差 **9.2px**；按横带切开确认头/中/脚三条带
 * **同向同幅**一起移动——就是整只猫在平移。屏幕上表现为用户报的「宠物看起来
 * 还是在左右摆动」，而清单里没有任何 sway/bob，查了很久才落到这一条。
 *
 * 用等权而不是 alpha 加权：阈值已经把 AI 出图留下的半透明残晕滤掉了
 * （见 `NormalizeOptions.bboxThreshold`），剩下的边缘像素算一半质量反而会让
 * 重心随描边粗细漂移。阈值与 `alphaBBox` 保持同一个口径。
 *
 * **垂直方向仍要用地线（包围盒底边）而不是重心**：角色站在地面上，脚底才是稳定参照；
 * 重心会随「抬手 / 蹲下」上下浮动，用它对齐会让抬手帧整体下沉。见 `align.ts` 头注释。
 */
export function alphaCentroidX(buf: Buffer, w: number, h: number, thr = 128): number | null {
  let sum = 0
  let n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (buf[(y * w + x) * 4 + 3] > thr) {
        sum += x
        n++
      }
    }
  }
  return n === 0 ? null : sum / n
}

/**
 * 估算图像背景色：取四角邻域的众数。
 *
 * 必要而非可选——实测提示词写 `#D9218F`，实际产出在 `#d11b89`–`#db1782` 之间波动，
 * 写死底色会让整个抠底偏掉。
 *
 * `sample` 是边框带的厚度，会被夹到 `min(w,h)/8` 以内：**采样带必须比图本身薄**。
 * 精灵表切片这类小图上，固定 24px 的带会盖住整张图，众数转而选到角色自身的颜色
 * （实测 96×32 的图被自己的描边色骗到）。大图不受影响，仍是 24px。
 */
export function estimateBackground(rgba: Buffer, w: number, h: number, sample = 24): RGB {
  const band = Math.max(1, Math.min(sample, Math.floor(Math.min(w, h) / 8)))
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4
    const k = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)
    const e = buckets.get(k) ?? { n: 0, r: 0, g: 0, b: 0 }
    e.n++
    e.r += rgba[i]
    e.g += rgba[i + 1]
    e.b += rgba[i + 2]
    buckets.set(k, e)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < band || x >= w - band || y < band || y >= h - band) add(x, y)
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e
  if (!best) return [255, 0, 255]
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)]
}

/** `#RRGGBB` / `RRGGBB` → RGB；非法返回 null */
export function parseHexColor(v: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** RGB → `#rrggbb` */
export const formatHexColor = (c: RGB): string =>
  '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
