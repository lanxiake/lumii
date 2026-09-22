#!/usr/bin/env node
/**
 * motion-frames.mjs — 把 H3 出的帧序列做成能用的精灵图帧
 *
 * 四步，对应四个各自会让成品作废的故障：
 *
 *   cut   —— 抠底。H3 输出的背景**不是**你铺的那个色（实测铺 #00FFFF，
 *            出来是 rgb(24,220,226)），所以每帧都得重新估一次 key 色。
 *   snap  —— 对齐。H3 的第 0 帧理应复现 staged 参考图，但总有出入。
 *            **用第 0 帧标定一个全局变换，应用到整段**——逐帧对齐会让
 *            画面一帧一个缩放，播起来抖。这是 sprite_h3 的 frame-0 snap。
 *   pick  —— 选帧。107 帧里均匀取 8 帧（含首尾）。
 *   sheet —— 打包成图集。
 *
 * 参数默认值取自 sprite_h3（fmmix/sprite_h3，MIT）的 example 模板。
 *
 * 用法：
 *   node motion-frames.mjs cut  <帧目录> <输出目录>
 *   node motion-frames.mjs snap <帧目录> <输出目录> --ref <staging.json>
 *   node motion-frames.mjs pick <帧目录> <输出目录> [--count 8]
 *   node motion-frames.mjs sheet <帧目录> <输出.png> [--cols 4]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { alphaBBox, cutout, distanceField, floodOutside } from '../lib/cutout.mjs'

/** staging 时铺的 key 色。H3 的输出会偏，但不该偏太远。 */
const EXPECTED_KEY = [0, 255, 255]
const MAX_KEY_SHIFT = 96
/** flood fill 容差。取自 sprite_h3 的 background_tolerance。 */
const SOLID_TOLERANCE = 48

const listPng = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => /\.png$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f))

async function readRGBA(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, w: info.width, h: info.height }
}

/**
 * 估这一帧的实际 key 色。
 *
 * 只在**边界带**取样（角色不会在边上），并且只用**离期望色 ≤ 96** 的样本 ——
 * 这一层先验是关键：没有它，角色万一碰到边就会把估计带偏；
 * 有它，就算整段偏色（H3 常见）也只会筛掉坏样本，不会筛空。
 * 万一真筛空了（偏得离谱），退化成「取最近的四分之一」。
 */
function estimateKey(data, w, h, expected = EXPECTED_KEY, maxShift = MAX_KEY_SHIFT) {
  const samples = []
  const band = 4
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= band && x < w - band && y >= band && y < h - band) continue
      const i = (y * w + x) * 4
      samples.push([data[i], data[i + 1], data[i + 2]])
    }
  }
  const d2 = samples.map((c) => (c[0] - expected[0]) ** 2 + (c[1] - expected[1]) ** 2 + (c[2] - expected[2]) ** 2)
  let idx = samples.map((_, i) => i).filter((i) => d2[i] <= maxShift ** 2)
  if (!idx.length) {
    idx = samples
      .map((_, i) => i)
      .sort((a, b) => d2[a] - d2[b])
      .slice(0, Math.max(1, samples.length >> 2))
  }
  const med = (ch) => {
    const v = idx.map((i) => samples[i][ch]).sort((a, b) => a - b)
    return v[v.length >> 1]
  }
  return [med(0), med(1), med(2)]
}

/** 容差取「这批帧真实背景像素的距离上界」，比拍一个固定值更有依据。 */
function autoSolid(d) {
  const sorted = Float64Array.from(d).sort()
  const p = sorted[Math.floor(sorted.length * 0.995)]
  return Math.max(16, Math.min(SOLID_TOLERANCE, Math.ceil(p) + 4))
}

async function cutOne(file, outFile, expected) {
  const { data, w, h } = await readRGBA(file)
  const key = estimateKey(data, w, h, expected)
  const d = distanceField(data, w, h, key)
  const tSolid = autoSolid(d)
  const { data: cut } = cutout(data, w, h, key, { tSolid })
  const box = alphaBBox(cut, w, h, 16)
  await sharp(cut, { raw: { width: w, height: h, channels: 4 } }).png().toFile(outFile)
  return { key, tSolid, box }
}

/** 均匀取 count 个位置（含首尾）。整数 half-up，跟 sprite_h3 的算法一致。 */
export function uniformPositions(length, count) {
  if (count === 1) return [0]
  const den = count - 1
  return Array.from({ length: count }, (_, s) => Math.floor((2 * s * (length - 1) + den) / (2 * den)))
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const cmd = argv[0]
const src = argv[1]
const dst = argv[2]
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}

// 被 import 时不要跑 CLI —— `uniformPositions` 是给别的脚本用的导出
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
if (cmd === 'cut') {
  if (!src || !dst) throw new Error('用法：node motion-frames.mjs cut <帧目录> <输出目录>')
  const files = listPng(src)
  fs.mkdirSync(dst, { recursive: true })
  const keys = []
  let first = null
  for (const [i, f] of files.entries()) {
    const out = path.join(dst, path.basename(f))
    const r = await cutOne(f, out, EXPECTED_KEY)
    keys.push(r.key)
    if (!first) first = r
    if (i % 20 === 0 || i === files.length - 1) {
      console.log(`  ${i + 1}/${files.length}  key=${r.key.join(',')} tSolid=${r.tSolid} box=${r.box ? `${r.box.w}×${r.box.h}` : '空'}`)
    }
  }
  // key 色的漂移幅度直接决定抠底稳不稳：偏得多说明模型没守背景色，后面的帧要盯着看
  const spread = [0, 1, 2].map((c) => {
    const v = keys.map((k) => k[c])
    return Math.max(...v) - Math.min(...v)
  })
  console.log(`\nkey 色估计（逐帧各估一次）: 首帧 ${keys[0].join(',')} | 通道漂移 R${spread[0]} G${spread[1]} B${spread[2]}`)
  console.log(`✓ ${files.length} 帧 → ${dst}`)
} else if (cmd === 'snap') {
  if (!src || !dst) throw new Error('用法：node motion-frames.mjs snap <帧目录> <输出目录> --ref <staging.json>')
  const refPath = opt('ref')
  if (!refPath) throw new Error('需要 --ref <stage-frame.mjs 输出的 json>')
  const ref = JSON.parse(fs.readFileSync(refPath, 'utf-8'))
  const files = listPng(src)
  fs.mkdirSync(dst, { recursive: true })
  // 第 0 帧标定：它的角色高度 vs 参考图的角色高度 → 全局缩放
  const f0 = await readRGBA(files[0])
  const b0 = alphaBBox(f0.data, f0.w, f0.h, 16)
  if (!b0) throw new Error('第 0 帧抠完是空的，没法标定')
  const scale = ref.figureHeightPx / b0.h
  const targetW = Math.round(b0.w * scale)
  const left = Math.round((ref.canvas.w - targetW) / 2) - Math.round(b0.minX * scale)
  const top = ref.placement.baselineRow - Math.round(b0.h * scale) + 1 - Math.round(b0.minY * scale)
  console.log(`第 0 帧角色 ${b0.w}×${b0.h} @(${b0.minX},${b0.minY}) → 参考 ${ref.figureHeightPx}px 高`)
  console.log(`全局变换: scale=${scale.toFixed(4)} 偏移=(${left},${top})`)
  for (const [i, f] of files.entries()) {
    const out = path.join(dst, path.basename(f))
    // 整帧缩放再平移：一个变换管到底，帧间不会有各自的缩放
    const sw = Math.round(f0.w * scale)
    const sh = Math.round(f0.h * scale)
    const scaled = await sharp(f).resize(sw, sh, { kernel: 'lanczos3' }).png().toBuffer()
    await sharp({ create: { width: ref.canvas.w, height: ref.canvas.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: scaled, left, top }])
      .png()
      .toFile(out)
    if (i % 20 === 0 || i === files.length - 1) console.log(`  ${i + 1}/${files.length}`)
  }
  console.log(`✓ ${files.length} 帧 → ${dst}`)
} else if (cmd === 'pick') {
  if (!src || !dst) throw new Error('用法：node motion-frames.mjs pick <帧目录> <输出目录> [--count 8]')
  const count = Number(opt('count', 8))
  const files = listPng(src)
  const idx = uniformPositions(files.length, count)
  fs.mkdirSync(dst, { recursive: true })
  for (const [i, j] of idx.entries()) {
    fs.copyFileSync(files[j], path.join(dst, `p${String(i).padStart(2, '0')}_${path.basename(files[j])}`))
  }
  console.log(`${files.length} 帧 → 取 ${count} 帧，源下标 [${idx.join(', ')}]`)
  console.log(`✓ → ${dst}`)
} else if (cmd === 'sheet') {
  if (!src || !dst) throw new Error('用法：node motion-frames.mjs sheet <帧目录> <输出.png> [--cols 4] [--cell 448]')
  const cols = Number(opt('cols', 4))
  // 默认 448 = 客户端 `demo_anime_girl` 的格高（384×448，宽高比 0.857）。
  // 128 那一档角色只有 96px，放大就糊——用户反馈过。
  const cellH = Number(opt('cell', 448))
  const files = listPng(src)
  if (!files.length) throw new Error(`${src} 里没有 png`)
  const probe = await readRGBA(files[0])
  const cellW = Math.max(16, Math.round((cellH * probe.w) / probe.h / 2) * 2)
  const rows = Math.ceil(files.length / cols)
  const canvas = sharp({
    create: { width: cols * cellW, height: rows * cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
  const composites = []
  for (const [i, f] of files.entries()) {
    // **整帧缩放**，不重新取包围盒定位。
    //
    // 帧出 staging 时构图已经定死了（角色占 70% 高、基线 85.6%、水平居中），
    // 整帧缩放会一比一保留它。反过来"取包围盒再贴底"是错的：每一帧都按
    // **各自的**包围盒重新定位，等于把动作本身抹平——挥手时手臂抬高会让包围盒
    // 变宽，重新居中就把它推回去了。
    const tile = await sharp(f).resize(cellW, cellH, { kernel: 'lanczos3' }).png().toBuffer()
    composites.push({ input: tile, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH })
  }
  await canvas.composite(composites).png().toFile(dst)
  console.log(`✓ ${files.length} 帧 → ${cols}×${rows} 网格（格 ${cellW}×${cellH}）→ ${dst}`)
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf-8').split('*/')[0].replace(/^#!.*\n/, ''))
}
}
