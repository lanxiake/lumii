#!/usr/bin/env node
/**
 * inspect.mjs — 出图之后先看一眼：闸门判据 + 降采样字符画
 *
 * 为什么要有字符画：这台机器上的 Read 工具看不了图，而没有「看一眼」这步，
 * 闸门的 S1/S4/S6 只能证明「帧之间有稳定变化」，**证明不了这段变化读起来像不像挥手**。
 * 这是计划 §5.1 记下的那条盲区，字符画是目前最便宜的人工复核手段。
 *
 * 用法：node inspect.mjs <png> [cols rows]
 */

import sharp from 'sharp'
import { op } from '../lib/control.mjs'

const RAMP = ' .:-=+*#%@'

/**
 * 底色采样：取四角各一小块的中位色。
 *
 * 出图是**不透明**的（没有 alpha 通道），直接按亮度画字符画会把角色和底色糊成一团
 * ——实测整张图都是同一个字符。先认出底色，把它画成 `.`，角色才浮出来。
 */
function sampleBackground(data, w, h) {
  const pick = []
  const k = Math.max(2, Math.round(Math.min(w, h) * 0.01))
  for (const [ox, oy] of [
    [0, 0],
    [w - k, 0],
    [0, h - k],
    [w - k, h - k],
  ]) {
    for (let y = oy; y < oy + k; y++) {
      for (let x = ox; x < ox + k; x++) {
        const i = (y * w + x) * 4
        pick.push([data[i], data[i + 1], data[i + 2]])
      }
    }
  }
  const med = (c) => pick.map((p) => p[c]).sort((a, b) => a - b)[Math.floor(pick.length / 2)]
  return [med(0), med(1), med(2)]
}

/** 把一块 RGBA 降采样成字符画；`.` 表示底色 */
async function ascii(data, w, h, bg, outW = 46) {
  const cellW = Math.max(1, Math.round(w / outW))
  const cellH = cellW * 2 // 字符格高约为宽的 2 倍，免得脸被拉长
  const rows = Math.floor(h / cellH)
  const cols = Math.floor(w / cellW)
  const lines = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      let sum = 0
      let n = 0
      let bgish = 0
      for (let y = r * cellH; y < (r + 1) * cellH && y < h; y++) {
        for (let x = c * cellW; x < (c + 1) * cellW && x < w; x++) {
          const i = (y * w + x) * 4
          const d = Math.max(
            Math.abs(data[i] - bg[0]),
            Math.abs(data[i + 1] - bg[1]),
            Math.abs(data[i + 2] - bg[2]),
          )
          if (d <= 40) {
            bgish++
            continue
          }
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
          n++
        }
      }
      if (n === 0 || bgish / (n + bgish) > 0.7) {
        line += '.'
        continue
      }
      const lum = sum / n
      line += RAMP[Math.min(RAMP.length - 1, Math.floor(((255 - lum) / 255) * RAMP.length))]
    }
    lines.push(line)
  }
  return lines.join('\n')
}

const [file, colsArg, rowsArg, widthArg] = process.argv.slice(2)
if (!file) {
  console.error('用法: node inspect.mjs <png> [cols rows] [字符画宽度]')
  process.exit(1)
}

const cols = Number(colsArg) || 2
const rows = Number(rowsArg) || 2
/** 字符画宽度：默认 46 列，动作语义看不出来时调大（如 90） */
const outW = Number(widthArg) || 46

const chk = await op('sheetCheck', { input: file, cols, rows })
if (!chk.ok) {
  console.error('✗ sheetCheck 失败：', chk.error)
  process.exit(1)
}
const r = chk.result
console.log(`源图 ${r.source.w}×${r.source.h} ${r.source.format} · 网格 ${cols}×${rows}`)
console.log(`判定 ${r.verdict}`)
for (const p of r.problems ?? []) console.log(`  ⚠ ${p}`)
console.log(
  `  判据 S0 整除=${r.divisible} S1 不越格=${r.s1} S2 对中=${r.s2} S4 同一只=${r.s4}` +
    `(${(r.minPaletteOverlap * 100).toFixed(0)}%) S6 连续=${r.s6}` +
    `(首尾 ${r.loopDiff?.toFixed(1)} vs 相邻中位 ${r.baselineDiff?.toFixed(1)})` +
    ` S8 底色距=${r.bgDistance?.toFixed(0)}`,
)
if (r.cells?.length) {
  for (const c of r.cells) {
    console.log(
      `   格${c.index}(r${c.row}c${c.col}): 包围盒 ${c.bbox ? `${c.bbox.w}×${c.bbox.h}` : '空'}` +
        ` 底色 ${c.background} 容差 ${c.tSolid}${c.leakAt !== null ? ` 泄漏临界 ${c.leakAt}` : ''}` +
        ` 偏移 ${(c.centerOffset * 100).toFixed(1)}% 边界带 ${c.bleed}` +
        `${c.drewLine ? ' **画了分隔线**' : ''}`,
    )
  }
}

const { data, info } = await sharp(file, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const bg = sampleBackground(data, info.width, info.height)
console.log(`底色采样 #${bg.map((v) => v.toString(16).padStart(2, '0')).join('')}`)
const cw = Math.floor(info.width / cols)
const ch = Math.floor(info.height / rows)

for (let ry = 0; ry < rows; ry++) {
  for (let cx = 0; cx < cols; cx++) {
    const x0 = cx * cw
    const y0 = ry * ch
    const buf = Buffer.alloc(cw * ch * 4)
    for (let y = 0; y < ch; y++) {
      data.copy(buf, y * cw * 4, ((y0 + y) * info.width + x0) * 4, ((y0 + y) * info.width + x0 + cw) * 4)
    }
    console.log(`\n--- 第 ${ry * cols + cx + 1} 格（r${ry}c${cx}）`)
    console.log(await ascii(buf, cw, ch, bg, outW))
  }
}
