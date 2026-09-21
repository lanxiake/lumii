#!/usr/bin/env node
/**
 * qa-animation.mjs — 动画质量的两条量化判据（调研文档 §5.5 / §5.6 的落点）
 *
 * 对着**打包好的宠物包**量，不是对着原始图量：清单里怎么写、图集里怎么存，
 * 运行时看到的就是什么。线上出问题的是清单，不是出图。
 *
 * ## 两条判据要分开量，否则互相污染
 *
 * · **#5 稳定性**（`base` / `height` / `centroid` 的逐帧抖动）——量的是
 *   「角色有没有逐帧上下跳、忽大忽小」。它**不裁包围盒**，因为位置本身就是被测量。
 * · **#7 姿态差异度**——量的是「这段动作真的在动吗，还是几帧几乎一样」。
 *   它**先裁到各自的包围盒再缩到同一尺寸**，把位置/尺度信息剔除掉，
 *   剩下的才是姿势。不这么做的话，「整体平移 2px」会被记成「姿势变了」。
 *
 * 两条判据用不同的量，是被实测逼出来的：只做 #5 的话，一个把同一姿势
 * 平移来平移去的动画会被判成「很稳」；只做 #7 的话，一个逐帧上下跳的动画
 * 会被判成「姿势丰富」。
 *
 * ## 阈值
 *
 * 阈值**不在这里硬编码**，而是由 `--calibrate` 从一组合格的素材里量出来
 * （见调研文档 §5.5「阈值需用数据校准，先跑再定」）。
 * 本文件里的 `DEFAULT_LIMITS` 只是兜底，跑过校准后应当用校准值。
 *
 * 用法：
 *   node qa-animation.mjs <宠物包目录> [...]        量并出报告
 *   node qa-animation.mjs --calibrate <包目录> ...  只出统计量，用于定阈值
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(REPO, 'package.json'))
const sharp = require('sharp')

const ALPHA = 8
const POSE = 48 // 姿态比较的归一分辨率

/** 兜底阈值——**校准前不要当真**，跑 `--calibrate` 拿实测值 */
const DEFAULT_LIMITS = {
  /**
   * 塌缩判定用 `poseMax`（**不是** `poseMin`）。
   *
   * ⚠ 这里踩过一次：最初想用「两两差异的最小值」当塌缩判据——两帧长得一样就是塌缩。
   * 但 **Idle Pin 会故意造出一对完全相同的帧**（一次性动作的首末格都引用待机首帧），
   * 于是每个钉过的动作 `poseMin` 恒等于 0，判据全线误报。
   * 「最不像的两帧有多像」才是塌缩该问的问题，那就是 `poseMax`。
   *
   * 校准实测（19 条多帧动作）：真人画的走路循环落在 2.5–7.6，
   * 而 AI 直出的两只待机是 0.5（钢羽）与 1.4（团子）——**实质上是静止帧**。
   * 2.0 正好把这两只挑出来，又不误伤最保守的那条走路循环。
   */
  poseMax: 2.0,
  /** 基线抖只作回归哨兵：实测所有包都在 0–1px，「不是 0」就说明对齐链路坏了 */
  baseSpreadPx: 2,
}

/** 一帧：包围盒 + 裁到包围盒后归一到 POSE×POSE 的 alpha 覆盖度 */
async function frameStats(png, cache, key, region) {
  if (cache.has(key)) return cache.get(key)
  const { data, info } = await sharp(png)
    .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: C } = info
  let x0 = 1e9
  let x1 = -1
  let y0 = 1e9
  let y1 = -1
  let n = 0
  let sx = 0
  let sy = 0
  const mask = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * C + (C - 1)] > ALPHA) {
        mask[y * W + x] = 1
        n++
        sx += x
        sy += y
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  const out = { W, H, n, x0, x1, y0, y1, cx: n ? sx / n : NaN, cy: n ? sy / n : NaN }
  if (n > 0) {
    // 裁到包围盒 → 归一到正方形（**拉伸**而不是等比）：这里只关心「姿势分布」，
    // 等比缩放会把「胖了一圈」也算成形状变化，那归 #5 管
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    const pose = new Float32Array(POSE * POSE)
    for (let gy = 0; gy < POSE; gy++) {
      for (let gx = 0; gx < POSE; gx++) {
        let sum = 0
        let cnt = 0
        const ya = y0 + Math.floor((gy * bh) / POSE)
        const yb = y0 + Math.max(Math.floor(((gy + 1) * bh) / POSE), Math.floor((gy * bh) / POSE) + 1)
        const xa = x0 + Math.floor((gx * bw) / POSE)
        const xb = x0 + Math.max(Math.floor(((gx + 1) * bw) / POSE), Math.floor((gx * bw) / POSE) + 1)
        for (let y = ya; y < yb && y < H; y++) {
          for (let x = xa; x < xb && x < W; x++) {
            sum += mask[y * W + x]
            cnt++
          }
        }
        pose[gy * POSE + gx] = cnt ? sum / cnt : 0
      }
    }
    out.pose = pose
  }
  cache.set(key, out)
  return out
}

const diffPose = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return (s / a.length) * 100
}

const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0)

async function qaPackage(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
  const atlasJson = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf-8'))
  const png = path.join(dir, atlasJson.meta?.image ?? manifest.atlas)
  const cache = new Map()

  const rows = []
  for (const anim of manifest.animations ?? []) {
    const frames = []
    for (const f of anim.frames ?? []) {
      const name = f.base
      if (!name) continue
      const e = atlasJson.frames?.[name]
      if (!e) throw new Error(`${dir} 的 ${anim.group} 引用了图集里没有的 ${name}`)
      const b = e.frame ?? e
      frames.push(await frameStats(png, cache, name, b))
    }
    if (frames.length === 0) continue
    const empty = frames.filter((f) => f.n === 0).length
    const solid = frames.filter((f) => f.n > 0)

    const bases = solid.map((f) => f.y1)
    const heights = solid.map((f) => f.y1 - f.y0 + 1)
    const cxs = solid.map((f) => f.cx)
    const dims = solid.map((f) => f.W * f.H)
    // 姿态两两粗差
    let psum = 0
    let pmin = Infinity
    let pmax = 0
    let cnt = 0
    for (let i = 0; i < solid.length; i++) {
      for (let j = i + 1; j < solid.length; j++) {
        const d = diffPose(solid[i].pose, solid[j].pose)
        psum += d
        if (d < pmin) pmin = d
        if (d > pmax) pmax = d
        cnt++
      }
    }
    rows.push({
      pkg: manifest.id,
      group: anim.group,
      kind: anim.kind ?? 'loop',
      frames: frames.length,
      empty,
      baseSpread: spread(bases),
      baseSpreadPct: (spread(bases) / manifest.canvas.h) * 100,
      heightSpread: spread(heights),
      heightSpreadPct: (spread(heights) / manifest.canvas.h) * 100,
      cxSpread: spread(cxs),
      poseMean: cnt ? psum / cnt : 0,
      poseMin: cnt ? pmin : 0,
      poseMax: cnt ? pmax : 0,
      durations: (anim.frames ?? []).map((f) => f.durationMs ?? null),
      noDuration: (anim.frames ?? []).filter((f) => !(f.durationMs > 0)).length,
      canvas: manifest.canvas,
      atlasCells: [...new Set(dims)].length,
    })
  }
  return rows
}

const args = process.argv.slice(2)
const calibrate = args.includes('--calibrate')
const check = args.includes('--check')
const dirs = args.filter((a) => !a.startsWith('--'))
if (dirs.length === 0) {
  console.error('用法：node qa-animation.mjs [--calibrate] [--check] <宠物包目录> ...')
  process.exit(2)
}

const all = []
for (const d of dirs) all.push(...(await qaPackage(path.resolve(d))))

console.log(
  '宠物包'.padEnd(22) +
    '动作'.padEnd(8) +
    '类型'.padEnd(6) +
    '帧'.padStart(3) +
    ' 空帧' +
    ' 基线抖'.padStart(8) +
    ' 高抖'.padStart(7) +
    ' 重心抖'.padStart(8) +
    ' 姿态均/最小/最大'.padStart(20) +
    ' 缺时长',
)
for (const r of all) {
  console.log(
    r.pkg.padEnd(22) +
      r.group.padEnd(8) +
      r.kind.padEnd(6) +
      String(r.frames).padStart(3) +
      String(r.empty).padStart(4) +
      `${r.baseSpread}px(${r.baseSpreadPct.toFixed(1)}%)`.padStart(12) +
      `${r.heightSpread}px(${r.heightSpreadPct.toFixed(1)}%)`.padStart(12) +
      `${r.cxSpread.toFixed(1)}px`.padStart(10) +
      `${r.poseMean.toFixed(1)}/${r.poseMin.toFixed(1)}/${r.poseMax.toFixed(1)}`.padStart(20) +
      String(r.noDuration).padStart(6),
  )
}

if (calibrate) {
  const multi = all.filter((r) => r.frames > 1)
  const nums = (k) => multi.map((r) => r[k]).sort((a, b) => a - b)
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : NaN)
  const line = (label, arr) =>
    console.log(
      `  ${label.padEnd(18)} n=${String(arr.length).padStart(3)}  ` +
        `min=${arr[0]?.toFixed(2)}  p50=${pct(arr, 0.5)?.toFixed(2)}  ` +
        `p90=${pct(arr, 0.9)?.toFixed(2)}  max=${arr[arr.length - 1]?.toFixed(2)}`,
    )
  console.log(`\n校准（只统计多帧动作，n=${multi.length}）：`)
  line('基线抖 %', nums('baseSpreadPct'))
  line('高抖 %', nums('heightSpreadPct'))
  line('重心抖 px', nums('cxSpread'))
  line('姿态均 poseMean', nums('poseMean'))
  line('姿态最小 poseMin', nums('poseMin'))
  line('姿态最大 poseMax ←判据', nums('poseMax'))
  console.log(
    '\n  · 基线抖/高抖 量的是**动画本身的幅度**（跳起来当然高抖大），不是质量，别拿来判好坏。\n' +
      '  · 基线抖实测全在 0–1px：地线由 `normalize`/裁剪保证，这条是**回归哨兵**。\n' +
      '  · poseMin 会被 Idle Pin 压成 0（两端是同一张图），**不能用它判塌缩**。',
  )
}

if (check) {
  console.log('\n判据（阈值见 DEFAULT_LIMITS）：')
  let bad = 0
  for (const r of all) {
    const issues = []
    if (r.frames > 1 && r.poseMax < DEFAULT_LIMITS.poseMax) {
      issues.push(`姿态塌缩：最不像的两帧也只差 ${r.poseMax.toFixed(1)}（下限 ${DEFAULT_LIMITS.poseMax}）`)
    }
    if (r.baseSpread > DEFAULT_LIMITS.baseSpreadPx) {
      issues.push(`地线抖 ${r.baseSpread}px（上限 ${DEFAULT_LIMITS.baseSpreadPx}）`)
    }
    if (r.empty > 0) issues.push(`有 ${r.empty} 个空帧`)
    const label = `${r.pkg} / ${r.group}`
    if (issues.length) {
      bad++
      console.log(`  ✗ ${label}：${issues.join('；')}`)
    } else {
      console.log(`  ✓ ${label}`)
    }
  }
  console.log(bad ? `\n✗ ${bad} 条不过` : '\n✓ 全部通过')
  if (bad) process.exitCode = 1
}
