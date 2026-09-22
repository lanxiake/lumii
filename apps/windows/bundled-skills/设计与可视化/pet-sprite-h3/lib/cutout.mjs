#!/usr/bin/env node
/**
 * cutout.mjs — 连通性抠底算法（验证点 A 与 D 共用）
 *
 * 算法要点（两处关键，均由验证点 A 的实测逼出来）：
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

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v)

/** 低 alpha 反预乘的稳定化窗口：低于 LO 处改用参考前景色，避免除以接近 0 的数 */
const STAB_LO = 0.05
const STAB_HI = 0.2

export const colorDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * 反预乘 + 低 alpha 稳定化。
 *
 * F = (C − (1−a)·B) / a 在 a→0 时把输入误差放大数十倍；
 * 而这些像素对最终画面的贡献与 a 成正比（近乎不可见），故低 alpha 区改用参考前景色。
 */
export function unpremultiply(C, a, B, ref) {
  if (a <= 0) return [0, 0, 0]
  if (a >= 1) return C
  const un = [0, 1, 2].map((k) => clamp255((C[k] - (1 - a) * B[k]) / a))
  const w = clamp01((a - STAB_LO) / (STAB_HI - STAB_LO))
  return [0, 1, 2].map((k) => Math.round(w * un[k] + (1 - w) * ref[k]))
}

/** 距离场：每个像素到背景色的欧氏距离 */
export function distanceField(rgba, w, h, B) {
  const N = w * h
  const d = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    d[i] = Math.hypot(rgba[i * 4] - B[0], rgba[i * 4 + 1] - B[1], rgba[i * 4 + 2] - B[2])
  }
  return d
}

/** 从图像四边 flood fill，标记「与边界连通的背景区」 */
export function floodOutside(d, w, h, tSolid) {
  const N = w * h
  const outside = new Uint8Array(N)
  const stack = []
  const push = (i) => {
    if (outside[i] === 0 && d[i] <= tSolid) { outside[i] = 1; stack.push(i) }
  }
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
  while (stack.length) {
    const i = stack.pop()
    const x = i % w, y = (i / w) | 0
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
 *
 * @returns 选中的 tSolid
 */
export function tuneSolid(rgba, w, h, B, { maxSolid = 254, leakRatio = 0.9, steps = 24 } = {}) {
  const d = distanceField(rgba, w, h, B)
  const N = w * h
  let best = Math.round(maxSolid * 0.5)

  // 从小到大扫，找第一个「泄漏」点，取它前一步
  let prevRatio = 0
  for (let s = 1; s <= steps; s++) {
    const t = Math.round((s / steps) * maxSolid)
    const outside = floodOutside(d, w, h, t)
    let cnt = 0
    for (let i = 0; i < N; i++) if (outside[i]) cnt++
    const ratio = cnt / N
    if (ratio > leakRatio) {
      best = Math.max(1, Math.round(((s - 1) / steps) * maxSolid))
      return { tSolid: best, leakAt: t, leakRatio: ratio, prevRatio }
    }
    prevRatio = ratio
    best = t
  }
  return { tSolid: best, leakAt: null, leakRatio: prevRatio, prevRatio }
}

/**
 * 抠底主函数。
 *
 * @param {Buffer} rgba 不透明 RGBA 像素
 * @param {number[]} B 背景色 RGB
 * @param {number} tLow 距离 ≤ tLow 直接判透明（应覆盖底色噪声上限）
 * @param {number} tSolid flood fill 容差；省略时自动调参
 */
export function cutout(rgba, w, h, B, { tLow = 25, tSolid } = {}) {
  const N = w * h
  const tuning = tSolid === undefined ? tuneSolid(rgba, w, h, B) : { tSolid, leakAt: null }
  const tS = tSolid ?? tuning.tSolid

  const d = distanceField(rgba, w, h, B)
  const outside = floodOutside(d, w, h, tS)

  // 实心种子 = 未被填充到、且不贴底色（角色内部 + 被包住的部位）
  const solid = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (!outside[i] && d[i] > tLow) solid[i] = 1

  // 多源 BFS：把实心种子的颜色传播给所有非实心像素，作为「最近前景色」参考
  const refR = new Uint8Array(N), refG = new Uint8Array(N), refB = new Uint8Array(N)
  const seen = new Uint8Array(N)
  const q = []
  for (let i = 0; i < N; i++) {
    if (solid[i]) {
      seen[i] = 1
      refR[i] = rgba[i * 4]; refG[i] = rgba[i * 4 + 1]; refB[i] = rgba[i * 4 + 2]
      q.push(i)
    }
  }
  for (let head = 0; head < q.length; head++) {
    const i = q[head]
    const x = i % w, y = (i / w) | 0
    const go = (j) => {
      if (seen[j]) return
      seen[j] = 1
      refR[j] = refR[i]; refG[j] = refG[i]; refB[j] = refB[i]
      q.push(j)
    }
    if (x > 0) go(i - 1)
    if (x < w - 1) go(i + 1)
    if (y > 0) go(i - w)
    if (y < h - 1) go(i + w)
  }

  const out = Buffer.alloc(N * 4)
  let opaqueCount = 0, semiCount = 0
  for (let i = 0; i < N; i++) {
    const C = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]
    let a
    if (d[i] <= tLow) a = 0
    else if (!outside[i]) a = 1
    else {
      const F = [refR[i], refG[i], refB[i]]
      const dRef = Math.hypot(F[0] - B[0], F[1] - B[1], F[2] - B[2])
      a = dRef < 1 ? 0 : clamp01(d[i] / dRef)
    }
    if (a >= 0.999) opaqueCount++
    else if (a > 0.001) semiCount++

    const F = unpremultiply(C, a, B, [refR[i], refG[i], refB[i]])
    out[i * 4] = F[0]; out[i * 4 + 1] = F[1]; out[i * 4 + 2] = F[2]
    out[i * 4 + 3] = Math.round(a * 255)
  }

  return { data: out, tuning: { ...tuning, tSolid: tS }, opaqueCount, semiCount }
}

/** alpha > 阈值的像素包围盒 */
export function alphaBBox(buf, w, h, thr = 16) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
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
 * alpha > 阈值的像素在 x 方向的**质量重心**（逐像素等权）。
 *
 * ⚠ **必须与 `packages/pet-asset/src/cutout.ts` 的 `alphaCentroidX` 完全一致**——
 * 客户端的归一化默认按重心对齐（`horizontalAlign: 'centroid'`），这里量出来的数
 * 要能预测它会怎么摆，口径差一点结论就偏。
 *
 * 默认阈值取 **128**（不是 `alphaBBox` 那个 16）：对齐口径用的是 128，
 * 16 会把描边外的半透明残晕也算成角色。两个默认值不同是**故意的**，
 * 别"统一"掉——抠底（`cutout`）与对齐是两件事。
 *
 * 为什么要它：包围盒是**极值**统计，重心是**质量**统计。角色身上只要有一个
 * 位置固定的极值点（耳朵尖、尾巴梢、拖地的影子），包围盒就被它钉住不动，
 * 而身体在里面左右摇——实测团子待机 8 帧包围盒中心极差 1.0px、重心极差 9.2px。
 */
export function alphaCentroidX(buf, w, h, thr = 128) {
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
 * 估算图像背景色：取四角邻域的众数（AI 出图的底色通常覆盖大部分边缘）。
 */
export function estimateBackground(rgba, w, h, sample = 24) {
  const buckets = new Map()
  const add = (x, y) => {
    const i = (y * w + x) * 4
    const k = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)
    const e = buckets.get(k) ?? { n: 0, r: 0, g: 0, b: 0 }
    e.n++; e.r += rgba[i]; e.g += rgba[i + 1]; e.b += rgba[i + 2]
    buckets.set(k, e)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < sample || x >= w - sample || y < sample || y >= h - sample) add(x, y)
    }
  }
  let best = null
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e
  if (!best) return [255, 0, 255]
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)]
}
