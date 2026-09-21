#!/usr/bin/env node
/**
 * sheet-rows.mjs — 给一张 Shimeji 精灵表出「行清单」
 *
 * Shimeji 表的惯例是**一行一个动作**、格 = 128×128。但惯例不等于事实：
 * 有些行只用了前几格，有些行是空的，有些动作比 128 宽会溢出到邻格。
 * 所以这里全部**量出来**，不按惯例假设。
 *
 * 每行给出：
 *   · 帧数（去掉尾部空格后的长度）
 *   · 逐帧包围盒 —— 底边 y1 的抖动就是 #5「baseline 跳变」的原始数据
 *   · 溢出：包围盒贴到格边（内容被切掉了）
 *   · 闭环度：首帧与末帧的粗差 —— 判断它是不是循环动作
 *   · 姿态差异度：两两粗差的均值和最小值 —— #7「防塌缩」的校准数据
 *
 * ## 粗差怎么算
 *
 * 先降采样到 32×32 的 alpha 覆盖度网格（不是逐像素比）：逐像素比会把
 * 1px 的边缘位移放大成巨大差异，而那种位移在动画里是正常的。
 * 降采样后每格是一次面积平均，1px 位移只影响边缘格，量级自然被压下去。
 * 这与 `idle-pin` 判据用的是同一套思路。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(path.resolve(fileURLToPath(import.meta.url), '../../../../package.json'))
const sharp = require('sharp')

const D =
  process.env.SHEET_DIR ??
  'C:/myself/projects/my/open-source/AI-desktop-pets/app/src/main/res/drawable-nodpi'
const CELL = Number(process.env.CELL ?? 128)
const GRID = 32 // 粗差比较用的降采样网格
const ALPHA = 8 // alpha 阈值
const TOUCH = 2 // 距格边几像素内算「贴边」

/** 一格的 alpha 覆盖度网格（GRID×GRID，0..1）+ 包围盒 */
function cellStats(data, W, C, cx, cy) {
  const cov = new Float32Array(GRID * GRID)
  let x0 = 1e9
  let x1 = -1
  let y0 = 1e9
  let y1 = -1
  let n = 0
  const bw = CELL / GRID
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const px = cx * CELL + x
      const py = cy * CELL + y
      if (data[(py * W + px) * C + (C - 1)] > ALPHA) {
        n++
        if (px < x0) x0 = px
        if (px > x1) x1 = px
        if (py < y0) y0 = py
        if (py > y1) y1 = py
        cov[Math.floor(y / bw) * GRID + Math.floor(x / bw)] += 1 / (bw * bw)
      }
    }
  }
  return { n, cov, x0, x1, y0, y1 }
}

/** 两张覆盖度网格的「粗差」：平均绝对差 × 100 */
function diff(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return (s / a.length) * 100
}

async function analyse(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: C } = info
  if (W % CELL || H % CELL) return { file, bad: `${W}x${H} 不是 ${CELL} 的整数倍` }
  const cols = W / CELL
  const rows = H / CELL

  const out = []
  for (let r = 0; r < rows; r++) {
    const cells = []
    for (let c = 0; c < cols; c++) cells.push(cellStats(data, W, C, c, r))
    // 尾部空格去掉；中间的窟窿保留（那是真窟窿，按 0 帧算会改变读序）
    let last = -1
    for (let i = 0; i < cells.length; i++) if (cells[i].n > 0) last = i
    const used = cells.slice(0, last + 1)
    if (used.length === 0) {
      out.push({ row: r, frames: 0 })
      continue
    }
    const holes = used.map((c, i) => (c.n === 0 ? i : -1)).filter((i) => i >= 0)
    const solid = used.filter((c) => c.n > 0)
    const bottoms = solid.map((c) => c.y1 - r * CELL)
    const tops = solid.map((c) => c.y0 - r * CELL)
    const widths = solid.map((c) => c.x1 - c.x0 + 1)
    const heights = solid.map((c) => c.y1 - c.y0 + 1)
    // 贴边要拿**格内坐标**判，不能拿全图绝对坐标：col 0 的绝对 x0 天然接近 0，
    // 用绝对坐标会把每一行的第一格都误判成「内容被切掉了」。所以这里带上列号。
    const touch = used.filter((c, i) => {
      if (c.n === 0) return false
      return (
        c.x0 - i * CELL <= TOUCH ||
        (i + 1) * CELL - 1 - c.x1 <= TOUCH ||
        c.y0 - r * CELL <= TOUCH ||
        CELL - 1 - (c.y1 - r * CELL) <= TOUCH
      )
    }).length

    // 两两粗差
    let sum = 0
    let cnt = 0
    let min = Infinity
    let minPair = ''
    for (let i = 0; i < solid.length; i++) {
      for (let j = i + 1; j < solid.length; j++) {
        const d = diff(solid[i].cov, solid[j].cov)
        sum += d
        cnt++
        if (d < min) {
          min = d
          minPair = `${i}~${j}`
        }
      }
    }
    out.push({
      row: r,
      frames: used.length,
      holes,
      touch,
      widths,
      heights,
      topSpread: tops.length ? Math.max(...tops) - Math.min(...tops) : 0,
      baseSpread: bottoms.length ? Math.max(...bottoms) - Math.min(...bottoms) : 0,
      baseRange: `${Math.min(...bottoms)}..${Math.max(...bottoms)}`,
      loopDiff: diff(solid[0].cov, solid[solid.length - 1].cov),
      poseMean: cnt ? sum / cnt : 0,
      poseMin: cnt ? min : 0,
      minPair,
    })
  }
  return { file, cols, rows, out }
}

const files = fs
  .readdirSync(D)
  .filter((f) => /\.png$/i.test(f) && f !== 'icon.png')
  .filter((f) => process.argv.length > 2 && process.argv.slice(2).includes(f))
  .sort()

for (const f of files) {
  const r = await analyse(path.join(D, f))
  console.log(`\n===== ${f} =====`)
  if (r.bad) {
    console.log(`  ⚠ ${r.bad}`)
    continue
  }
  console.log(`  ${r.cols}×${r.rows} 格`)
  console.log(
    '  行  帧数  空洞  贴边  宽×高(逐帧)                     底边范围  基线抖  首末粗差  姿态均值/最小(最小对)',
  )
  for (const row of r.out) {
    if (row.frames === 0) {
      console.log(`  ${String(row.row).padStart(2)}    —   (整行空)`)
      continue
    }
    const wh = row.widths.map((w, i) => `${w}×${row.heights[i]}`).join(' ')
    console.log(
      `  ${String(row.row).padStart(2)}  ${String(row.frames).padStart(3)}  ` +
        `${String(row.holes.length).padStart(4)}  ${String(row.touch).padStart(4)}  ` +
        wh.padEnd(38) +
        `  ${row.baseRange.padEnd(9)} ${String(row.baseSpread).padStart(5)}px  ` +
        `${row.loopDiff.toFixed(1).padStart(7)}  ` +
        `${row.poseMean.toFixed(1).padStart(7)} / ${row.poseMin.toFixed(1).padStart(5)}`,
    )
  }
}
