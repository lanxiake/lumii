#!/usr/bin/env node
/**
 * matte-sheet.mjs — **本地**把原始精灵表抠成 RGBA（替代 ComfyUI 图里的色键）
 *
 * 为什么搬到本地（2026-10-04）：
 *
 * 1. 工作流里的 `ColorToMask` 是**二值硬阈值**，只决定透明不透明，不修颜色——
 *    边缘那圈被底色钓走的像素 alpha 拿到了、RGB 还带着底色，就是用户看到的「紫边」。
 * 2. H3 **只锚定首帧**，后续帧背景是模型自己生成的（PDMD 下中段变**近黑**），
 *    与首帧铺的键色对不上，一个固定 key 抠不了整段。
 *
 * 本脚本用 `lib/cutout.mjs` 的**连通域 + 反预乘**算法逐格处理：
 *   · 逐格从**边框取样**估计该格自己的背景色（紫 / 近黑各算各的）；
 *   · 从图像边界 flood fill 找「与边界连通的背景」——被描边包住的部位（内耳、
 *     黑发里被轮廓圈住的部分）不会被误伤，这是纯阈值法做不到的；
 *   · alpha 用 `d(C,B)/d(F最近前景,B)` 还原真实覆盖率，并**反预乘**去掉底色分量——
 *     这一步就是数学意义上的去溢色（边缘不再带紫/黑）。
 *
 * 用法：
 *   node matte-sheet.mjs <原始表.png> <输出表.png> [--cols 8] [--cell 576x448]
 *                        [--bg RRGGBB] [--thresh N] [--quiet]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { cutout, estimateBackground, alphaBBox } from '../lib/cutout.mjs'
import { dropDetachedBlobs } from '../lib/detached-blobs.mjs'

const argv = process.argv.slice(2)
const IS_MAIN = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}
const has = (n) => argv.includes(`--${n}`)

/**
 * 从边框取样，聚类出**多个**背景色（最多 `maxColors` 个）。
 *
 * 为什么要多个：实测 H3 中段帧的背景**同一格内就可能不止一种**——边框是输入铺的紫
 * `rgb(153,3,226)`，角色原来站的地方被模型重画成了绿 `rgb(0,237,110)`。
 * 单键色必然漏掉另一种，于是留下 1 万像素级的大块残留（实测格1 有 9566px@(103,83)）。
 */
export function estimateBackgrounds(rgba, w, h, { maxColors = 3, sample = null, merge = 64 } = {}) {
  const s = sample ?? Math.max(4, Math.round(Math.min(w, h) * 0.04))
  const pts = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x < s || x >= w - s || y < s || y >= h - s) pts.push([rgba[(y * w + x) * 4], rgba[(y * w + x) * 4 + 1], rgba[(y * w + x) * 4 + 2]])
  // 简单的贪心聚类：按出现频次取种子，距离 < merge 的并入同一簇
  const centers = []
  for (const p of pts) {
    let hit = null
    for (const c of centers) if (Math.hypot(p[0] - c.r, p[1] - c.g, p[2] - c.b) < merge) { hit = c; break }
    if (hit) { hit.n++; hit.r += (p[0] - hit.r) / hit.n; hit.g += (p[1] - hit.g) / hit.n; hit.b += (p[2] - hit.b) / hit.n }
    else centers.push({ r: p[0], g: p[1], b: p[2], n: 1 })
  }
  return centers
    .filter((c) => c.n >= Math.max(8, pts.length * 0.02))
    .sort((a, b) => b.n - a.n)
    .slice(0, maxColors)
    .map((c) => [Math.round(c.r), Math.round(c.g), Math.round(c.b)])
}

/**
 * 边界连通的**区域生长**：从图像四边向内长，只要「与当前像素色差 ≤ tLocal」且
 * 「与所在区域种子色差 ≤ tGlobal」，就判为背景。
 *
 * 为什么比"取一个键色 + 全局距离"强：模型画的背景**形状自由**——底色可能是渐变、
 * 也可能同格出现两种颜色（紫+绿），还可能是它自己加的背景元素（云雾/色块）。
 * 只要这些**与画面边界连通**、且相邻像素颜色连续，区域生长就能整片吃掉；
 * 而被角色描边**包住**的内部区域（内耳、黑发里被轮廓圈住的部分）因为不连通，
 * 一律保留。这正是 `lib/cutout.mjs` 注释里说的"连通性区分背景与被包住的同色区"，
 * 区别是本函数允许**逐像素**放宽——渐变和多色背景都能长过去。
 */
export function growBackground(rgba, w, h, { tLocal = 16, tGlobal = 110 } = {}) {
  const N = w * h
  const isBg = new Uint8Array(N)
  const seed = new Float32Array(N * 3)
  const stack = []
  const push = (i) => {
    if (isBg[i]) return
    isBg[i] = 1
    seed[i * 3] = rgba[i * 4]; seed[i * 3 + 1] = rgba[i * 4 + 1]; seed[i * 3 + 2] = rgba[i * 4 + 2]
    stack.push(i)
  }
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
  while (stack.length) {
    const i = stack.pop()
    const x = i % w, y = (i / w) | 0
    const pr = rgba[i * 4], pg = rgba[i * 4 + 1], pb = rgba[i * 4 + 2]
    const sr = seed[i * 3], sg = seed[i * 3 + 1], sb = seed[i * 3 + 2]
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= h) continue
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= w) continue
        const q = yy * w + xx
        if (isBg[q]) continue
        const qr = rgba[q * 4], qg = rgba[q * 4 + 1], qb = rgba[q * 4 + 2]
        if (Math.hypot(qr - pr, qg - pg, qb - pb) <= tLocal && Math.hypot(qr - sr, qg - sg, qb - sb) <= tGlobal) push(q)
      }
    }
  }
  return isBg
}

/**
 * 单格抠底。
 *
 * 三种模式（2026-10-04 实测后定的）：
 *
 * · `mode: 'hard'`（默认）——**逐像素到「最近的」背景色的欧氏距离**做硬键：
 *   `d <= tol` 判背景、`d >= tol+feather` 判前景，中间线性过渡当 1px 抗锯齿。
 *   背景色**逐格从边框聚类**（`estimateBackgrounds`，默认取到 3 个），
 *   因为实测同一格的背景可能紫绿并存。
 * · `mode: 'soft'`——`lib/cutout.mjs` 的连通域 + 反预乘（背景带噪/带渐变时更稳，
 *   但平背景上会把大片背景算成半透明，反而糊）。
 *
 * 无论哪种，逐格都从**边框取样**估自己的背景色（`--bg` 可强制为单色）。
 */
export function matteCell(rgba, w, h, { bg = null, tLow = 25, tol = 60, feather = 1.5, mode = 'hard', growLocal = 16, growGlobal = 110 } = {}) {
  const Bs = bg ? (Array.isArray(bg[0]) ? bg : [bg]) : estimateBackgrounds(rgba, w, h)
  const B = Bs[0] || [255, 0, 255]
  if (mode === 'grow') {
    const N2 = w * h
    const isBg = growBackground(rgba, w, h, { tLocal: growLocal, tGlobal: growGlobal })
    // 二值前景 + 3x3 均值做 1px 抗锯齿
    const a0 = new Float32Array(N2)
    for (let i = 0; i < N2; i++) a0[i] = isBg[i] ? 0 : 1
    const out = Buffer.alloc(N2 * 4)
    let opaqueCount = 0
    let semiCount = 0
    for (let i = 0; i < N2; i++) {
      const x = i % w, y = (i / w) | 0
      let sum = 0
      let cnt = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          sum += a0[yy * w + xx]
          cnt++
        }
      }
      const cov = sum / cnt
      const a = Math.round(cov * 255)
      if (a >= 250) opaqueCount++
      else if (a > 2) semiCount++
      if (a === 0) {
        out[i * 4] = 0; out[i * 4 + 1] = 0; out[i * 4 + 2] = 0; out[i * 4 + 3] = 0
        continue
      }
      if (cov >= 0.999) {
        out[i * 4] = rgba[i * 4]; out[i * 4 + 1] = rgba[i * 4 + 1]; out[i * 4 + 2] = rgba[i * 4 + 2]; out[i * 4 + 3] = 255
        continue
      }
      // 反预乘去溢色：拿邻域里最近的背景像素色当 B
      let bR = B[0], bG = B[1], bB = B[2]
      let found = false
      for (let r = 1; r <= 2 && !found; r++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            const xx = x + dx, yy = y + dy
            if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue
            if (isBg[yy * w + xx]) { const p = (yy * w + xx) * 4; bR = rgba[p]; bG = rgba[p + 1]; bB = rgba[p + 2]; found = true }
          }
        }
      }
      const f = [0, 1, 2].map((k) => {
        const Bk = k === 0 ? bR : k === 1 ? bG : bB
        const v = (rgba[i * 4 + k] - (1 - cov) * Bk) / cov
        return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
      })
      out[i * 4] = f[0]; out[i * 4 + 1] = f[1]; out[i * 4 + 2] = f[2]; out[i * 4 + 3] = a
    }
    return { data: out, B, Bs, tuning: { mode: 'grow', growLocal, growGlobal }, opaqueCount, semiCount, box: alphaBBox(out, w, h, 16) }
  }
  if (mode === 'soft') {
    const { data, tuning, opaqueCount, semiCount } = cutout(rgba, w, h, B, { tLow })
    return { data, B, Bs, tuning, opaqueCount, semiCount, box: alphaBBox(data, w, h, 16) }
  }
  // hard：到**最近**背景色的距离硬键 + 线性羽化。alpha 只在 [tol, tol+feather] 之间过渡。
  const N = w * h
  const out = Buffer.alloc(N * 4)
  const dist = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2]
    let dmin = Infinity
    let near = B
    for (const c of Bs) {
      const d = Math.hypot(r - c[0], g - c[1], b - c[2])
      if (d < dmin) { dmin = d; near = c }
    }
    dist[i] = dmin
    out[i * 4 + 3] = 0 // 占位，下面统一填
    void near
  }
  let opaqueCount = 0
  let semiCount = 0
  for (let i = 0; i < N; i++) {
    const d = dist[i]
    const a = d <= tol ? 0 : d >= tol + feather ? 255 : Math.round(((d - tol) / feather) * 255)
    if (a >= 250) opaqueCount++
    else if (a > 2) semiCount++
    if (a === 0) {
      out[i * 4] = 0; out[i * 4 + 1] = 0; out[i * 4 + 2] = 0; out[i * 4 + 3] = 0
      continue
    }
    // 去溢色：边缘带（alpha<250）按覆盖率反预乘，扣掉**最近那个背景色**的分量。
    let best = B, bd = Infinity
    for (const c of Bs) {
      const dd = Math.hypot(rgba[i * 4] - c[0], rgba[i * 4 + 1] - c[1], rgba[i * 4 + 2] - c[2])
      if (dd < bd) { bd = dd; best = c }
    }
    const cov = a / 255
    if (cov >= 0.999) {
      out[i * 4] = rgba[i * 4]; out[i * 4 + 1] = rgba[i * 4 + 1]; out[i * 4 + 2] = rgba[i * 4 + 2]; out[i * 4 + 3] = 255
      continue
    }
    const f = [0, 1, 2].map((k) => {
      const v = (rgba[i * 4 + k] - (1 - cov) * best[k]) / cov
      return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
    })
    out[i * 4] = f[0]; out[i * 4 + 1] = f[1]; out[i * 4 + 2] = f[2]; out[i * 4 + 3] = a
  }
  return { data: out, B, Bs, tuning: { mode: 'hard', tol, feather, colors: Bs.length }, opaqueCount, semiCount, box: alphaBBox(out, w, h, 16) }
}

async function main() {
  const src = argv[0]
  const dst = argv[1]
  if (!src || !dst) {
    console.error('用法：node matte-sheet.mjs <原始表.png> <输出表.png> [--cols 8] [--cell WxH] [--bg RRGGBB] [--thresh N]')
    process.exit(1)
  }
  const cols = Number(flag('cols', 8))
  const cellArg = flag('cell', null)
  const bgArg = flag('bg', null)
  const tLow = Number(flag('thresh', 25))
  const tol = Number(flag('tol', 60))
  const feather = Number(flag('feather', 1.5))
  const mode = flag('mode', 'hard')
  const growLocal = Number(flag('grow-local', 16))
  const growGlobal = Number(flag('grow-global', 110))
  const quiet = has('quiet')

  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H } = info
  const [cw, ch] = cellArg ? cellArg.split('x').map(Number) : [Math.round(W / cols), H]
  if (cw * cols > W) throw new Error(`表宽 ${W} 装不下 ${cols} 格 × ${cw}px`)

  const out = Buffer.alloc(W * H * 4)
  const stats = []
  for (let i = 0; i < cols; i++) {
    const cell = Buffer.alloc(cw * ch * 4)
    // 从整表里裁出这一格
    for (let y = 0; y < ch; y++) {
      const srcOff = (y * W + i * cw) * 4
      data.copy(cell, y * cw * 4, srcOff, srcOff + cw * 4)
    }
    const res = matteCell(cell, cw, ch, { bg: bgArg ? hexToRgbArr(bgArg) : null, tLow, tol, feather, mode, growLocal, growGlobal })
    // 抠完之后拦一道碎块：模型在中段重画背景会被色键漏成"渣"，小且远离本体的一律抹掉
    const blobs = dropDetachedBlobs(res.data, cw, ch, { smallArea: Number(flag('blob-max', 420)), minGap: 6 })
    const op = res.opaqueCount / (cw * ch)
    stats.push({ i, bg: res.Bs, opaque: op, semi: res.semiCount, box: res.box, dropped: blobs.dropped.length })
    if (!quiet) {
      console.log(
        `  格${i}  键色 [${res.Bs.map((c) => c.join(',')).join(' | ')}]  不透明 ${(op * 100).toFixed(1)}%  半透 ${res.semiCount}px` +
          (blobs.dropped.length ? `  抹碎块 ${blobs.dropped.length}（${blobs.dropped.reduce((a, b) => a + b.area, 0)}px）` : '') +
          (res.box ? `  框 ${res.box.w}×${res.box.h}` : '  ⚠ 无前景'),
      )
    }
    // 写回整表
    for (let y = 0; y < ch; y++) {
      res.data.copy(out, (y * W + i * cw) * 4, y * cw * 4, y * cw * 4 + cw * 4)
    }
  }

  fs.mkdirSync(path.dirname(path.resolve(dst)), { recursive: true })
  await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toFile(dst)
  const bad = stats.filter((s) => s.opaque > 0.9 || s.opaque < 0.02)
  console.log(`✓ ${dst}（${cols} 格）`)
  if (bad.length) {
    console.log(`  ⚠ ${bad.length} 格 alpha 异常（>90% 或 <2% 不透明）：格 ${bad.map((b) => b.i).join('、')}——多半是背景估计偏了，用 --bg 指定再跑`)
  }
  return { stats, dst }
}

function hexToRgbArr(hex) {
  const s = String(hex).replace('#', '')
  return [0, 2, 4].map((k) => parseInt(s.slice(k, k + 2), 16))
}

if (IS_MAIN) {
  await main()
}
