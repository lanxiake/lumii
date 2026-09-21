#!/usr/bin/env node
/**
 * sheet-ascii.mjs — 把精灵表某些行画成 ASCII，用来「看」每行到底是什么动作
 *
 * 本机 Read 工具读不了图（见记忆），所以判断「这行是走路还是坐下」只能靠这个。
 * 不是逐格画满 128×128：先取该行**所有格的并集包围盒**，按它裁剪再降采样——
 * 角色通常只占格子的三分之一，画满格子等于浪费分辨率。
 *
 * 用法：node sheet-ascii.mjs <表名> <行号,行号,...> [每格宽 默认 20]
 */
import { createRequire } from 'node:module'
import path from 'node:path'
const require = createRequire('C:/myself/projects/my/open-source/lumii/package.json')
const sharp = require('sharp')

const D =
  process.env.SHEET_DIR ??
  'C:/myself/projects/my/open-source/AI-desktop-pets/app/src/main/res/drawable-nodpi'
const CELL = 128
const ALPHA = 8

const [file, rowsArg, widthArg] = process.argv.slice(2)
const rowList = rowsArg.split(',').map(Number)
const CW = Number(widthArg ?? 20)
const CH = Math.round(CW * 0.85) // 终端字符高约为宽的两倍，压扁一点补偿

const { data, info } = await sharp(path.join(D, file))
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })
const { width: W, channels: C } = info
const cols = Math.floor(W / CELL)

for (const r of rowList) {
  // 该行用了几格
  let last = -1
  for (let c = 0; c < cols; c++) {
    let n = 0
    for (let y = r * CELL; y < (r + 1) * CELL; y++)
      for (let x = c * CELL; x < (c + 1) * CELL; x++)
        if (data[(y * W + x) * C + (C - 1)] > ALPHA) n++
    if (n > 0) last = c
  }
  if (last < 0) {
    console.log(`\n### 行 ${r}：整行空`)
    continue
  }
  // 并集包围盒（格内坐标）
  let ux0 = 1e9
  let ux1 = -1
  let uy0 = 1e9
  let uy1 = -1
  for (let c = 0; c <= last; c++) {
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const px = c * CELL + x
        const py = r * CELL + y
        if (data[(py * W + px) * C + (C - 1)] > ALPHA) {
          if (x < ux0) ux0 = x
          if (x > ux1) ux1 = x
          if (y < uy0) uy0 = y
          if (y > uy1) uy1 = y
        }
      }
    }
  }
  const bw = (ux1 - ux0 + 1) / CW
  const bh = (uy1 - uy0 + 1) / CH
  console.log(
    `\n### 行 ${r}：${last + 1} 格，并集包围盒 ${ux1 - ux0 + 1}×${uy1 - uy0 + 1}（格内 x${ux0}..${ux1} y${uy0}..${uy1}）`,
  )
  const ramp = ' .:-=+*#%@'
  const lines = []
  for (let c = 0; c <= last; c++) {
    const grid = []
    for (let gy = 0; gy < CH; gy++) {
      let line = ''
      for (let gx = 0; gx < CW; gx++) {
        let sum = 0
        let n = 0
        for (let y = uy0 + Math.floor(gy * bh); y < uy0 + Math.floor((gy + 1) * bh); y++) {
          for (let x = ux0 + Math.floor(gx * bw); x < ux0 + Math.floor((gx + 1) * bw); x++) {
            if (y < 0 || y >= CELL || x < 0 || x >= CELL) continue
            const px = c * CELL + x
            const py = r * CELL + y
            sum += data[(py * W + px) * C + (C - 1)] > ALPHA ? 1 : 0
            n++
          }
        }
        const v = n ? sum / n : 0
        line += v < 0.08 ? ' ' : ramp[Math.min(9, 1 + Math.floor(v * 9))]
      }
      grid.push(line)
    }
    lines.push(grid)
  }
  // 每行（屏幕行）把各格并排
  const perLine = Math.max(1, Math.floor(100 / (CW + 2)))
  for (let s = 0; s < lines.length; s += perLine) {
    const group = lines.slice(s, s + perLine)
    const label = group.map((_, i) => (`#${s + i}`).padEnd(CW + 2)).join('')
    console.log(label)
    for (let gy = 0; gy < CH; gy++) console.log(group.map((g) => g[gy].padEnd(CW + 2)).join(''))
  }
}
