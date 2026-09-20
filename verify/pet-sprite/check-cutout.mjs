#!/usr/bin/env node
/**
 * check-cutout.mjs — 验证点 A：抠底 / 切片 / 锚点对齐（验证计划 T2）
 *
 * 三项独立判据：
 *   A1 抠底   —— 品红底被移除，边缘无残留色晕，且**不误伤与底色接近的部位**
 *   A2 网格切片 —— 4×4 图集切成 16 张等大帧，无偏移、可逆重建
 *   A3 锚点对齐 —— 分离部件按锚点拼回，像素级对齐且坐标为偶数
 *
 * A1 的度量方式：拿 fixtures/char-alpha.png 当真值。
 *   char-magenta 由「真值 alpha 合成到品红底」得到（C = a·F + (1−a)·B），
 *   所以真值就是抠底算法的精确答案，可逐像素比对，不依赖目视。
 *
 * A1 同时跑**两种算法**并对比，用来记录一个关键发现：
 *   V1 全局距离阈值 —— 结构性不可行（陷阱色与边缘像素在距离维度上不可区分）
 *   V2 连通性 + 最近前景色归一化 —— 可行
 *
 * 用法：node verify/pet-sprite/check-cutout.mjs
 */

import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const EVIDENCE = join(HERE, '..', '..', 'docs', 'test', 'pet-sprite', 'evidence')

/** 底色（与 gen-fixtures 保持一致） */
const BG = [0xd9, 0x21, 0x8f]
/** 容差陷阱色 */
const TRAP = [0xe8, 0x44, 0x9a]

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v)
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// ---------------------------------------------------------------------------
// 算法 V1：全局距离阈值（朴素做法，用于对照）
// ---------------------------------------------------------------------------

function cutoutV1(rgba, w, h, B, tLow, tHigh) {
  const out = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const C = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]
    const d = dist(C, B)
    let a
    if (d <= tLow) a = 0
    else if (d >= tHigh) a = 1
    else a = (d - tLow) / (tHigh - tLow)

    let F = C
    if (a > 0 && a < 1) F = [0, 1, 2].map((k) => clamp255((C[k] - (1 - a) * B[k]) / a))
    else if (a === 0) F = [0, 0, 0]

    out[i * 4] = F[0]; out[i * 4 + 1] = F[1]; out[i * 4 + 2] = F[2]
    out[i * 4 + 3] = Math.round(a * 255)
  }
  return out
}

// ---------------------------------------------------------------------------
// 算法 V2：连通性 + 最近前景色归一化
// ---------------------------------------------------------------------------

/**
 * 反预乘 + 低 alpha 数值稳定化。
 *
 * 反预乘 F = (C − (1−a)·B) / a 在 a→0 时除以接近 0 的数，会把输入误差放大数十倍。
 * 实测：195 个真值抗锯齿像素的 alpha 落在 0.0–0.2，正是误差主要来源。
 *
 * 这些像素对最终画面的贡献本就与 a 成正比（近乎不可见），故在低 alpha 区改用
 * 「参考前景色」，并在 [STAB_LO, STAB_HI] 区间平滑混合，避免出现色带。
 */
const STAB_LO = 0.05
const STAB_HI = 0.2

function unpremultiply(C, a, B, ref, stabilize) {
  if (a <= 0) return [0, 0, 0]
  if (a >= 1) return C
  const un = [0, 1, 2].map((k) => clamp255((C[k] - (1 - a) * B[k]) / a))
  if (!stabilize) return un.map(Math.round)
  const w = clamp01((a - STAB_LO) / (STAB_HI - STAB_LO))
  return [0, 1, 2].map((k) => Math.round(w * un[k] + (1 - w) * ref[k]))
}

/**
 * V3：连通性 + **实心种子**参考前景色。
 *
 * 相比 V2 的关键修正 —— V2 用 `tTravel=110` 做 flood fill，导致抗锯齿带中
 * 距离落在 (110, 表面色距离) 区间的大量像素**没被填充到**，于是被误判为「实心前景」
 * 并成为参考色种子。用半透明像素的颜色当基准去算 a = d/dRef，dRef 偏小 → a 高估
 * → 反预乘减掉的底色不够 → 残留品红（实测最差像素 a 估 0.279、真值 0.161）。
 *
 * 修正：把 flood fill 容差提到 `tSolid`（需大过表面色距底色的距离，如墨线 189），
 * 使整条抗锯齿带都被划入「连通背景区」，种子只落在真正不透明的像素上：
 *   - 被包住的（内耳/鼻头陷阱色、身体内部）—— 与 V2 相同，靠连通性保住
 *   - 连通的但距离 > tSolid —— 即深入形状内部、AA 影响不到的像素
 *
 * @param {number} tLow    距离 ≤ tLow 直接判透明（需覆盖底色噪声上限 ~14）
 * @param {number} tSolid  实心判定阈值；同时用作 flood fill 行走容差
 */
function cutoutV3(rgba, w, h, B, { tLow = 25, tSolid = 178 } = {}) {
  const N = w * h

  // --- 1. 距离场 ---
  const d = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    d[i] = Math.hypot(rgba[i * 4] - B[0], rgba[i * 4 + 1] - B[1], rgba[i * 4 + 2] - B[2])
  }

  // --- 2. 从边界 flood fill（4 邻域），行走容差 = tSolid ---
  const outside = new Uint8Array(N)
  const stack = []
  const tryPush = (i) => {
    if (outside[i] === 0 && d[i] <= tSolid) { outside[i] = 1; stack.push(i) }
  }
  for (let x = 0; x < w; x++) { tryPush(x); tryPush((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { tryPush(y * w); tryPush(y * w + w - 1) }
  while (stack.length) {
    const i = stack.pop()
    const x = i % w, y = (i / w) | 0
    if (x > 0) tryPush(i - 1)
    if (x < w - 1) tryPush(i + 1)
    if (y > 0) tryPush(i - w)
    if (y < h - 1) tryPush(i + w)
  }

  // --- 3. 实心种子 = 未被填充到、且不贴底色（身体内部 + 被包住的陷阱色）---
  const solid = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if (!outside[i] && d[i] > tLow) solid[i] = 1
  }

  // --- 4. 多源 BFS：把实心种子的颜色传播给所有非实心像素 ---
  const refR = new Uint8Array(N), refG = new Uint8Array(N), refB = new Uint8Array(N)
  const seen = new Uint8Array(N)
  const q = []
  for (let i = 0; i < N; i++) if (solid[i]) {
    seen[i] = 1
    refR[i] = rgba[i * 4]; refG[i] = rgba[i * 4 + 1]; refB[i] = rgba[i * 4 + 2]
    q.push(i)
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

  // --- 5. 定 alpha ---
  const out = Buffer.alloc(N * 4)
  let trapEnclosed = 0, trapLeaked = 0, solidSeeds = 0
  for (let i = 0; i < N; i++) if (solid[i]) solidSeeds++

  for (let i = 0; i < N; i++) {
    const C = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]

    let a
    if (d[i] <= tLow) {
      a = 0
    } else if (!outside[i]) {
      a = 1                                    // 被前景包住 → 实心（陷阱色走这里）
    } else {
      const F = [refR[i], refG[i], refB[i]]
      const dRef = Math.hypot(F[0] - B[0], F[1] - B[1], F[2] - B[2])
      a = dRef < 1 ? 0 : clamp01(d[i] / dRef)
    }

    if (d[i] > tLow && dist(C, TRAP) < 20) {
      if (outside[i]) trapLeaked++; else trapEnclosed++
    }

    const F = unpremultiply(C, a, B, [refR[i], refG[i], refB[i]], true)
    out[i * 4] = F[0]; out[i * 4 + 1] = F[1]; out[i * 4 + 2] = F[2]
    out[i * 4 + 3] = Math.round(a * 255)
  }
  return { data: out, trapEnclosed, trapLeaked, solidSeeds }
}

// ---------------------------------------------------------------------------
// 度量
// ---------------------------------------------------------------------------

/**
 * 与真值比对。
 *  - alphaMAE：掩膜还原精度
 *  - pmMAE：**预乘颜色**平均绝对误差 —— 「合成到任意背景上像不像」的正确判据。
 *    直接比非预乘 RGB 会在边缘产生假误差（半透明像素的颜色本就不该被单独比较）。
 */
function compare(cut, gt, w, h) {
  let sumA = 0, sumPm = 0
  const n = w * h
  for (let i = 0; i < n; i++) {
    const ac = cut[i * 4 + 3] / 255
    const ag = gt[i * 4 + 3] / 255
    sumA += Math.abs(ac - ag)
    for (let k = 0; k < 3; k++) sumPm += Math.abs(ac * cut[i * 4 + k] - ag * gt[i * 4 + k])
  }
  return { alphaMAE: sumA / n, pmMAE: sumPm / (n * 3) }
}

/** 陷阱色存活率：真值里属于陷阱色的不透明像素，在结果里是否仍被判为前景 */
function trapSurvival(cut, gt, w, h) {
  let total = 0, kept = 0
  for (let i = 0; i < w * h; i++) {
    if (gt[i * 4 + 3] < 250) continue
    if (dist([gt[i * 4], gt[i * 4 + 1], gt[i * 4 + 2]], TRAP) > 20) continue
    total++
    if (cut[i * 4 + 3] > 200) kept++
  }
  return { total, kept, rate: total ? kept / total : 1 }
}

/**
 * 色晕度量：真值中处于抗锯齿过渡带的像素，抠底后颜色是否仍偏向底色。
 * 底色特征为「B 通道高、G 通道低」，故以 (B − G) 作为品红偏向指标，与真值同像素比较。
 *
 * 同时给出 **alpha 加权**值：像素对最终画面的贡献与 alpha 成正比，
 * 一个 a=0.05 的边缘像素色偏 30，视觉影响远小于 a=0.9 的色偏 30。
 * 加权值是更贴近观感的判据，未加权值保留作对照（避免悄悄放宽标准）。
 */
function fringe(cut, gt, w, h) {
  let sum = 0, sumW = 0, wSum = 0, n = 0
  for (let i = 0; i < w * h; i++) {
    const ag = gt[i * 4 + 3]
    if (ag === 0 || ag === 255) continue
    const ac = cut[i * 4 + 3] / 255
    if (ac <= 6 / 255) continue
    const spill = Math.max(0, (cut[i * 4 + 2] - cut[i * 4 + 1]) - (gt[i * 4 + 2] - gt[i * 4 + 1]))
    sum += spill
    sumW += ac * spill
    wSum += ac
    n++
  }
  return {
    meanSpill: n ? sum / n : 0,
    meanSpillWeighted: wSum > 0 ? sumW / wSum : 0,
    edgePixels: n,
  }
}

// ---------------------------------------------------------------------------
// A1 抠底
// ---------------------------------------------------------------------------

async function checkA1() {
  console.log('[A1] 抠底 —— 与真值逐像素比对')
  console.log('')

  const src = await sharp(join(FIXTURES, 'char-magenta.png'))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const gtBuf = await sharp(join(FIXTURES, 'char-alpha.png'))
    .ensureAlpha().raw().toBuffer()
  const { width: w, height: h } = src.info

  const pad = (s, n) => String(s).padEnd(n, ' ')
  // 判据：掩膜精度 + 预乘误差 + 陷阱存活 + **alpha 加权色晕**（贴近观感的判据）
  const judge = (r) =>
    r.alphaMAE < 0.02 && r.pmMAE < 3 && r.rate > 0.95 && r.meanSpillWeighted < 12

  // ---- V1 对照：多容差档位 ----
  console.log('  V1 全局距离阈值（朴素做法）：')
  console.log('  ' + pad('档位', 7) + pad('tLow/tHigh', 12) + pad('alphaMAE', 11) + pad('预乘MAE', 10) + pad('陷阱存活', 10) + pad('色晕', 8) + '判定')
  const TOL = [
    { name: '过松', tLow: 10, tHigh: 40 },
    { name: '适中', tLow: 25, tHigh: 70 },
    { name: '偏紧', tLow: 40, tHigh: 110 },
    { name: '过紧', tLow: 60, tHigh: 150 },
  ]
  const v1rows = []
  for (const t of TOL) {
    const cut = cutoutV1(src.data, w, h, BG, t.tLow, t.tHigh)
    const r = { ...t, ...compare(cut, gtBuf, w, h), ...trapSurvival(cut, gtBuf, w, h), ...fringe(cut, gtBuf, w, h) }
    v1rows.push({ ...r, pass: judge(r) })
    console.log('  ' + pad(r.name, 7) + pad(`${r.tLow}/${r.tHigh}`, 12) + pad(r.alphaMAE.toFixed(5), 11) +
      pad(r.pmMAE.toFixed(2), 10) + pad(`${(r.rate * 100).toFixed(1)}%`, 10) + pad(r.meanSpill.toFixed(1), 8) +
      (r.pass ? '✓' : '✗'))
  }
  const v1any = v1rows.some((r) => r.pass)
  console.log(`  V1 结论：${v1any ? '存在可行档位' : '✗ 无任何档位同时满足 —— 陷阱色与边缘像素在距离维度不可区分，属结构性缺陷'}`)

  // ---- V3 连通性 + 实心种子 ----
  console.log('')
  console.log('  V3 连通性 + 实心种子参考色：')
  const v3params = [
    { name: 'tSolid=140', tLow: 25, tSolid: 140 },
    { name: 'tSolid=160', tLow: 25, tSolid: 160 },
    { name: 'tSolid=178', tLow: 25, tSolid: 178 },
    { name: 'tSolid=200', tLow: 25, tSolid: 200 },
    { name: 'tLow=18/178', tLow: 18, tSolid: 178 },
  ]
  const v3rows = []
  let best = null
  for (const p of v3params) {
    const res = cutoutV3(src.data, w, h, BG, p)
    const r = {
      ...p,
      ...compare(res.data, gtBuf, w, h),
      ...trapSurvival(res.data, gtBuf, w, h),
      ...fringe(res.data, gtBuf, w, h),
      trapEnclosed: res.trapEnclosed,
      trapLeaked: res.trapLeaked,
      solidSeeds: res.solidSeeds,
    }
    r.pass = judge(r)
    v3rows.push(r)
    if (!best || r.pmMAE < best.pmMAE) best = r
    await sharp(res.data, { raw: { width: w, height: h, channels: 4 } })
      .png().toFile(join(EVIDENCE, `cutout-v3-${p.name.replace(/[^\w-]/g, '_')}.png`))
    console.log('  ' + pad(r.name, 14) + pad(`tLow=${r.tLow}`, 10) +
      pad(r.alphaMAE.toFixed(5), 11) + pad(r.pmMAE.toFixed(2), 10) +
      pad(`${(r.rate * 100).toFixed(1)}%`, 10) +
      pad(r.meanSpillWeighted.toFixed(1), 9) + pad(r.meanSpill.toFixed(1), 9) +
      pad(`${r.solidSeeds}`, 9) + (r.pass ? '✓ PASS' : '✗'))
  }
  console.log('  ' + pad('', 14) + pad('', 10) + pad('alphaMAE', 11) + pad('预乘MAE', 10) +
    pad('陷阱存活', 10) + pad('色晕(加权)', 9) + pad('色晕(原始)', 9) + pad('实心种子', 9) + '判定')

  const v3pass = v3rows.filter((r) => r.pass)
  const pass = v3pass.length > 0
  console.log('')
  console.log(`  陷阱色连通性诊断：被包住保留 ${v3rows[0].trapEnclosed} px / 泄漏 ${v3rows[0].trapLeaked} px`)
  console.log(`  边缘过渡像素：${v3rows[0].edgePixels} 个`)
  if (pass) {
    console.log(`[A1] ✓ PASS —— V3 可行，通过档位：${v3pass.map((r) => r.name).join('、')}`)
  } else {
    console.log('[A1] ✗ FAIL —— V3 仍未达标')
  }

  // 证据图：V1 最优档，供与 V3 结果目视对比
  const v1best = v1rows.reduce((a, b) => (a.pmMAE < b.pmMAE ? a : b))
  await sharp(cutoutV1(src.data, w, h, BG, v1best.tLow, v1best.tHigh), { raw: { width: w, height: h, channels: 4 } })
    .png().toFile(join(EVIDENCE, 'cutout-v1-best.png'))

  return {
    pass,
    v1: { rows: v1rows, anyPass: v1any },
    v3: { rows: v3rows, best },
    edgePixels: v3rows[0].edgePixels,
  }
}

// ---------------------------------------------------------------------------
// A2 网格切片
// ---------------------------------------------------------------------------

async function checkA2() {
  console.log('')
  console.log('[A2] 网格切片 —— 4×4 图集切 16 帧，要求等大、无偏移、可逆重建')

  const src = await sharp(join(FIXTURES, 'sheet-4x4.png'))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H } = src.info
  const CELL = 32, COLS = 4, ROWS = 4

  if (W !== CELL * COLS || H !== CELL * ROWS) {
    console.log(`[A2] ✗ FAIL 图集尺寸 ${W}×${H} 与声明的 ${CELL * COLS}×${CELL * ROWS} 不符`)
    return { pass: false }
  }

  const cells = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const buf = Buffer.alloc(CELL * CELL * 4)
      for (let y = 0; y < CELL; y++) {
        const srcOff = ((r * CELL + y) * W + c * CELL) * 4
        src.data.copy(buf, y * CELL * 4, srcOff, srcOff + CELL * 4)
      }
      cells.push(buf)
    }
  }

  const sizeOk = cells.length === 16 && cells.every((b) => b.length === CELL * CELL * 4)

  const rebuilt = Buffer.alloc(W * H * 4)
  let idx = 0
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const buf = cells[idx++]
      for (let y = 0; y < CELL; y++) {
        buf.copy(rebuilt, ((r * CELL + y) * W + c * CELL) * 4, y * CELL * 4, y * CELL * 4 + CELL * 4)
      }
    }
  }
  const reversible = rebuilt.equals(src.data)
  const distinct = new Set(cells.map((b) => b.toString('base64'))).size

  for (let i = 0; i < 4; i++) {
    await sharp(cells[i], { raw: { width: CELL, height: CELL, channels: 4 } })
      .resize(CELL * 4, CELL * 4, { kernel: 'nearest' })
      .png().toFile(join(EVIDENCE, `sheet-cell-${i}.png`))
  }

  console.log(`  尺寸精确      16 帧 × ${CELL}×${CELL}                    ${sizeOk ? '✓' : '✗'}`)
  console.log(`  可逆重建      拼回与原图逐字节一致              ${reversible ? '✓' : '✗'}`)
  console.log(`  帧内容互异    不同帧数 ${distinct}/16                    ${distinct === 16 ? '✓' : '✗'}`)

  const pass = sizeOk && reversible && distinct === 16
  console.log(`[A2] ${pass ? '✓ PASS' : '✗ FAIL'}`)
  return { pass, distinct, reversible }
}

// ---------------------------------------------------------------------------
// A3 锚点对齐
// ---------------------------------------------------------------------------

function alphaBBox(buf, w, h, thr = 8) {
  let minX = w, minY = h, maxX = -1, maxY = -1
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
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** 把部件按左上角 (ox,oy) 合成到画布（source-over） */
function blit(canvas, cw, ch, part, ox, oy, pw) {
  for (let y = 0; y < part.h; y++) {
    for (let x = 0; x < part.w; x++) {
      const sy = oy + y, sx = ox + x
      if (sy < 0 || sy >= ch || sx < 0 || sx >= cw) continue
      const pi = (y * part.w + x) * 4
      const a = part.data[pi + 3] / 255
      if (a === 0) continue
      const di = (sy * cw + sx) * 4
      for (let k = 0; k < 3; k++) {
        canvas[di + k] = Math.round(part.data[pi + k] * a + canvas[di + k] * (1 - a))
      }
      canvas[di + 3] = Math.max(canvas[di + 3], part.data[pi + 3])
    }
  }
}

async function checkA3() {
  console.log('')
  console.log('[A3] 锚点对齐 —— 部件按声明锚点拼回，要求像素级对齐且坐标为偶数')

  const partsDir = join(FIXTURES, 'parts')
  const load = async (name) => {
    const { data, info } = await sharp(join(partsDir, `${name}.png`))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return { data, w: info.width, h: info.height }
  }

  const body = await load('body')
  const eyes = await load('eye-open')
  const mouth = await load('mouth-0')

  // 声明：body 锚点 (32,60) 脚底中心；眼/嘴锚点均为图心（偶数尺寸 → 整数锚点）
  const bodyAnchor = { x: 32, y: 60 }
  const eyesAnchor = { x: eyes.w / 2, y: eyes.h / 2 }
  const mouthAnchor = { x: mouth.w / 2, y: mouth.h / 2 }

  // 眼/嘴在 body 局部坐标系中的目标落点（左上角）。偶数对齐是像素风缩放的前提。
  const eyesTarget = { x: 24, y: 24 }
  const mouthTarget = { x: 24, y: 36 }

  const evenOk = [body, eyes, mouth].every((p) => p.w % 2 === 0 && p.h % 2 === 0)
  const anchorIntOk = [bodyAnchor, eyesAnchor, mouthAnchor].every(
    (a) => Number.isInteger(a.x) && Number.isInteger(a.y),
  )
  const evenPlacementOk = [eyesTarget, mouthTarget].every((t) => t.x % 2 === 0 && t.y % 2 === 0)

  // 落点误差：合成后的 alpha 包围盒，应当等于「目标落点 + 部件自身包围盒偏移」
  const eyesBBox = alphaBBox(eyes.data, eyes.w, eyes.h)
  const eyesOnly = Buffer.alloc(body.w * body.h * 4)
  blit(eyesOnly, body.w, body.h, eyes, eyesTarget.x, eyesTarget.y, eyes.w)
  const composedBBox = alphaBBox(eyesOnly, body.w, body.h)
  const expected = { x: eyesTarget.x + eyesBBox.x, y: eyesTarget.y + eyesBBox.y }
  const eyesErr = composedBBox
    ? Math.max(Math.abs(composedBBox.x - expected.x), Math.abs(composedBBox.y - expected.y))
    : Infinity

  const composed = Buffer.alloc(body.w * body.h * 4)
  body.data.copy(composed)
  blit(composed, body.w, body.h, eyes, eyesTarget.x, eyesTarget.y, eyes.w)
  blit(composed, body.w, body.h, mouth, mouthTarget.x, mouthTarget.y, mouth.w)

  await sharp(composed, { raw: { width: body.w, height: body.h, channels: 4 } })
    .resize(body.w * 4, body.h * 4, { kernel: 'nearest' })
    .png().toFile(join(EVIDENCE, 'composite-parts.png'))

  console.log(`  部件尺寸为偶数   body ${body.w}×${body.h}, eye ${eyes.w}×${eyes.h}, mouth ${mouth.w}×${mouth.h}   ${evenOk ? '✓' : '✗'}`)
  console.log(`  锚点为整数       (${bodyAnchor.x},${bodyAnchor.y}) / (${eyesAnchor.x},${eyesAnchor.y}) / (${mouthAnchor.x},${mouthAnchor.y})            ${anchorIntOk ? '✓' : '✗'}`)
  console.log(`  落点为偶数       eye(${eyesTarget.x},${eyesTarget.y}) mouth(${mouthTarget.x},${mouthTarget.y})                    ${evenPlacementOk ? '✓' : '✗'}`)
  console.log(`  合成落点误差     ${eyesErr === Infinity ? '未命中' : eyesErr + 'px'}（要求 ≤ 1px）          ${eyesErr <= 1 ? '✓' : '✗'}`)

  const pass = evenOk && anchorIntOk && evenPlacementOk && eyesErr <= 1
  console.log(`[A3] ${pass ? '✓ PASS' : '✗ FAIL'}`)
  return { pass, eyesErr, evenOk, anchorIntOk, evenPlacementOk }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(EVIDENCE, { recursive: true })
  console.log('=== 验证点 A：抠底 / 切片 / 锚点对齐 ===')
  console.log('')

  const a1 = await checkA1()
  const a2 = await checkA2()
  const a3 = await checkA3()

  console.log('')
  console.log('─'.repeat(72))
  const all = a1.pass && a2.pass && a3.pass
  console.log(`验证点 A 总判定：${all ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  A1 抠底       ${a1.pass ? '✓' : '✗'}`)
  console.log(`  A2 网格切片   ${a2.pass ? '✓' : '✗'}`)
  console.log(`  A3 锚点对齐   ${a3.pass ? '✓' : '✗'}`)
  console.log('')
  console.log(`证据已写入：${EVIDENCE}`)

  await writeFile(
    join(EVIDENCE, 'check-cutout-result.json'),
    JSON.stringify({ a1, a2, a3, all }, null, 2) + '\n',
    'utf-8',
  )

  process.exit(all ? 0 : 1)
}

main().catch((err) => {
  console.error('[check-cutout] 失败:', err)
  process.exit(1)
})
