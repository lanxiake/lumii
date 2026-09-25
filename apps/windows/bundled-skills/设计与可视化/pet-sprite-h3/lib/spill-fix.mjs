/**
 * spill-fix.mjs —— 修**绿幕溢色（spill）**：角色边缘那圈被绿底钓走的颜色
 *
 * ## 为什么抠底之后再单独修一次颜色
 *
 * `ColorToMask` + 固定阈值只决定**透明不透明**，它管不到 RGB。角色边缘压在绿底上的
 * 像素 alpha 拿到了、颜色却还带着绿——留在画面上就是一圈绿晕。所以这是**抠完底之后**
 * 的一道独立工序，和碎块过滤（`detached-blobs.mjs`）同一条流水线上、各管各的：
 * 那道改 alpha（把碎块抹成透明），这道改 RGB 且 **alpha 一个都不动**（形状、描边、
 * 柔和度全不变）。
 *
 * ## 判据：绿超出量 `e = g - max(r, b)`
 *
 * 没有溢色的像素，绿分量不该**同时高于**红和蓝（浅绿的花瓣 e>0 是正常的，所以
 * 只在**边缘带**上动刀，内部一律不碰）。
 *
 * ## 两种修法，实测只有一种能用（2026-09-24 月兔小仙走路表）
 *
 *   · `clamp` —— 绿超过红蓝就压到红蓝那个高度。**看着对、其实是错的**：绿清掉了，
 *     边缘平均色却变成 `rgb(113,110,121)` 一条**灰边**，离角色本色
 *     `rgb(222,200,218)` 从 150 **远到** 171。等于把绿边换成灰边（混合像素里
 *     压掉绿，剩下的本来就是中性灰）。
 *   · `recolor`（默认用这个）—— 从"干净内部像素"（不透明且 e<=0）多源 BFS 一层层
 *     扩散颜色，边缘被钓走的像素换成扩散过来的颜色。实测边缘绿像素
 *     45,580 → 93，边缘平均色 `rgb(113,164,121)` → `rgb(169,155,178)`，
 *     离本色 150 → **80**，内部像素一个没碰。
 *
 * ## `maxdist` 闸门（必须和 recolor 一起做）
 *
 * 最近的干净源超过 `maxdist`（默认 6px）就**别用**那个颜色。实测只跳过 93 个像素，
 * 正好是飘在远处、模型自己撒的那些碎块——**它们不该被染成角色的颜色**（只会更显眼），
 * 那些归连通块过滤管。两道各管各的，别互相抢。
 */

/** 绿超出量 e = g - max(r, b) */
export const spill = (r, g, b) => g - Math.max(r, b)

/**
 * 从透明区膨胀出"边缘带"：`band[p]` = 该像素到最近透明像素的切比雪夫距离 + 1，
 * 透明像素本身 = 1。返回 `Uint8Array`（`0` = 距透明区比 `radius+2` 还远，即内部）。
 *
 * ⚠ 传进来的是** RGBA 缓冲**（不是 alpha 平面）——alpha 在 `p*4+3`。
 * 这里踩过一次：直接把 RGBA 当 alpha 平面读，读到的是 R 通道，于是
 * "红色通道 < 64 的像素"全被当成透明，边缘带糊满整张图、内部判定归零，
 * 后果是**把角色自己的绿元素（4,706 个像素）也一起改了色**——而那正是
 * 边缘带这道闸门存在的理由。
 */
export function edgeBand(rgba, N, w, h, radius) {
  const band = new Uint8Array(N)
  const clear = (p) => rgba[p * 4 + 3] < 64
  const dq = []
  for (let p = 0; p < N; p++) if (clear(p)) { band[p] = 1; dq.push(p) }
  for (let head = 0; head < dq.length; head++) {
    const p = dq[head], d = band[p]
    if (d > radius) continue
    const x = p % w, y = (p - x) / w
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= h) continue
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= w) continue
        const q = yy * w + xx
        if (band[q] === 0) { band[q] = d + 1; dq.push(q) }
      }
    }
  }
  return band
}

/**
 * 就地修一格（RGBA Buffer）。
 *
 * @param {Buffer} rgba 就地改
 * @param {number} w 格宽
 * @param {number} h 格高
 * @param {object} o
 *   · `method`   `recolor`（默认）/ `clamp`
 *   · `radius`   边缘带宽度（距透明区 ≤ radius 的不透明像素才算边缘），默认 3
 *   · `maxdist`  recolor 的源距闸门，默认 6
 *   · `strength` clamp 的压强（默认 1；recolor 不用）
 *   · `includeSemi` 半透明那一圈（64≤alpha<250 的抗锯齿边）**要不要一起换色，默认开**。
 *     这一圈是缩放/抗锯齿把角色边缘与绿底混出来的产物，实测**平均色 rgb(29,221,31)、
 *     平均 alpha 170、99.8% 的像素 e>0**，按 alpha 加权算它占了**整圈绿色的一半**
 *     （走路表 4.12M / 8.13M）。只修不透明像素的话剩余绿色权重几乎没降（49.1% vs
 *     clamp 的 49.3%）——所以这一圈必须在刀口里，不然这道工序白干一半。
 *     alpha 依旧一个字节不动，形状/描边/柔和度不变。
 *   · `solidOnly` 扩散只走实体（alpha≥64），默认开；见下面的注释。
 * @returns {{touched:number, skippedFar:number, distMax:number, semiTouched:number}}
 */
export function fixSpill(
  rgba, w, h,
  { method = 'recolor', radius = 3, maxdist = 6, strength = 1, includeSemi = true, solidOnly = true, keepLuma = true } = {},
) {
  const N = w * h
  const band = edgeBand(rgba, N, w, h, radius)
  const inScope = (p) => {
    if (!band[p] || band[p] > radius + 1) return false
    const a = rgba[p * 4 + 3]
    return includeSemi ? a >= 64 : a >= 250
  }

  if (method === 'clamp') {
    let touched = 0, sumDrop = 0
    for (let p = 0; p < N; p++) {
      if (!inScope(p)) continue
      const i = p * 4
      const cap = Math.max(rgba[i], rgba[i + 2])
      if (rgba[i + 1] <= cap) continue
      const ng = Math.round(cap + (1 - strength) * (rgba[i + 1] - cap))
      sumDrop += rgba[i + 1] - ng
      rgba[i + 1] = ng
      touched++
    }
    return { touched, skippedFar: 0, distMax: 0, semiTouched: 0, sumDrop }
  }

  // recolor：干净像素（不透明且 e<=0）当种子，一层层把颜色扩散出去
  //
  // `solidOnly`（默认开）：扩散只走 **alpha≥64 的实体像素**，不许跨过透明缝。
  // 放开的话 BFS 会穿过两条丝带之间 2~3px 的缝，把**另一条丝带**的颜色染过来——
  // 实测走路表 105 个像素受影响、最大单通道差 169（一条淡紫飘带的边缘被染成肤色）。
  // 关掉它没有任何好处：需要颜色的地方全都在实体上。
  const dist = new Int32Array(N).fill(-1)
  const col = new Int32Array(N * 3)
  const dq = []
  for (let p = 0; p < N; p++) {
    const i = p * 4
    if (rgba[i + 3] < 250) continue
    if (spill(rgba[i], rgba[i + 1], rgba[i + 2]) > 0) continue
    dist[p] = 0
    col[p * 3] = rgba[i]; col[p * 3 + 1] = rgba[i + 1]; col[p * 3 + 2] = rgba[i + 2]
    dq.push(p)
  }
  for (let head = 0; head < dq.length; head++) {
    const p = dq[head], d = dist[p]
    const x = p % w, y = (p - x) / w
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= h) continue
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= w) continue
        const q = yy * w + xx
        if (dist[q] !== -1) continue
        if (solidOnly && rgba[q * 4 + 3] < 64) continue
        dist[q] = d + 1
        col[q * 3] = col[p * 3]; col[q * 3 + 1] = col[p * 3 + 1]; col[q * 3 + 2] = col[p * 3 + 2]
        dq.push(q)
      }
    }
  }
  let touched = 0, skippedFar = 0, distMax = 0, semiTouched = 0
  for (let p = 0; p < N; p++) {
    if (!inScope(p)) continue
    const i = p * 4
    if (spill(rgba[i], rgba[i + 1], rgba[i + 2]) <= 0) continue
    const d = dist[p]
    // 源距闸门：远处的碎块染成角色色只会更显眼，那道留给连通块过滤
    if (d < 0 || d > maxdist) { skippedFar++; continue }
    if (d > distMax) distMax = d
    let sr = col[p * 3], sg = col[p * 3 + 1], sb = col[p * 3 + 2]
    if (keepLuma) {
      // **只借色相，不借明度**：把源色整体乘一个系数，让它的明度回到这个像素自己的。
      // 不加这一步的话，描边外侧那半圈（深紫描边与绿底混合 → 被判定有溢色）会被
      // 换成"最近的干净像素"的颜色，而描边只有 3~5px、外侧被污染后，最近的干净源
      // 往往已经是里面的浅色衣料 → **描边被洗淡**。实测走路表暗档平均明度
      // 101.9 → 139.3、待机表 101.5 → 145.1（+40 明度 = 肉眼可见的"边糊了"）。
      const l0 = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.178 * rgba[i + 2]
      const ls = 0.299 * sr + 0.587 * sg + 0.178 * sb
      const k = ls > 1 ? l0 / ls : 1
      sr = Math.min(255, Math.round(sr * k))
      sg = Math.min(255, Math.round(sg * k))
      sb = Math.min(255, Math.round(sb * k))
    }
    rgba[i] = sr; rgba[i + 1] = sg; rgba[i + 2] = sb
    touched++
    if (rgba[p * 4 + 3] < 250) semiTouched++
  }
  return { touched, skippedFar, distMax, semiTouched }
}

/**
 * 边缘带 / 内部 的溢色与平均色统计（口径与 temp/spill-probe.mjs 一致，便于对数）。
 *
 * 每档都带一个 `load`：**alpha 加权**的绿色总量 `Σ (a/255)·max(0,e)`。
 * 光数像素个数会骗人——一个 alpha=60 的像素只贡献 23% 的绿色，而 alpha=250 的贡献
 * 满额。判"哪一圈真的在画面上发绿"要按这个加权算（半透明那圈个数只有边缘带的
 * 一半，但 alpha 平均 170，权重并不小）。
 */
export function spillStats(rgba, w, h, radius = 3) {
  const N = w * h
  const band = edgeBand(rgba, N, w, h, radius)
  const acc = { edge: { n: 0, pos: 0, strong: 0, sumE: 0, maxE: -999, r: 0, g: 0, b: 0, load: 0 }, inner: { n: 0, pos: 0, strong: 0, sumE: 0, maxE: -999, r: 0, g: 0, b: 0, load: 0 } }
  for (let p = 0; p < N; p++) {
    const i = p * 4
    if (rgba[i + 3] < 250) continue
    const e = spill(rgba[i], rgba[i + 1], rgba[i + 2])
    const t = band[p] && band[p] <= radius + 1 ? acc.edge : acc.inner
    t.n++; t.r += rgba[i]; t.g += rgba[i + 1]; t.b += rgba[i + 2]
    if (e > 0) { t.pos++; t.sumE += e; t.load += (rgba[i + 3] / 255) * e }
    if (e > 30) t.strong++
    if (e > t.maxE) t.maxE = e
  }
  const fin = (t) => ({ ...t, meanPosE: t.pos ? t.sumE / t.pos : 0, meanRGB: t.n ? [Math.round(t.r / t.n), Math.round(t.g / t.n), Math.round(t.b / t.n)] : [0, 0, 0] })
  // 半透明那一圈（抗锯齿）单列：它是描边外沿与绿底的混合，绿色最浓，但默认不在刀口内
  const semi = { n: 0, pos: 0, sumA: 0, r: 0, g: 0, b: 0, load: 0 }
  for (let p = 0; p < N; p++) {
    const i = p * 4
    const a = rgba[i + 3]
    if (a < 64 || a >= 250) continue
    semi.n++; semi.sumA += a
    const e = spill(rgba[i], rgba[i + 1], rgba[i + 2])
    if (e > 0) { semi.pos++; semi.load += (a / 255) * e }
    semi.r += rgba[i]; semi.g += rgba[i + 1]; semi.b += rgba[i + 2]
  }
  return { edge: fin(acc.edge), inner: fin(acc.inner), semi: { ...semi, meanRGB: semi.n ? [Math.round(semi.r / semi.n), Math.round(semi.g / semi.n), Math.round(semi.b / semi.n)] : [0, 0, 0], meanA: semi.n ? semi.sumA / semi.n : 0 } }
}
