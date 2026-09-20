#!/usr/bin/env node
/**
 * check-sprite-sheet.mjs — 验证「让生图模型直出目标格式」（一次生成多姿态图集）
 *
 * 背景：链式图生图（验证点 D）已证明**每跳忠实但漂移会累积**（1 跳 IoU 91–93%，
 * 3 跳降到 73%），且参考图会压过文字提示。若模型能**一次生成多姿态图集**，
 * 则一致性由单次生成天然保证，同时把 N 次生成压缩成 1 次。
 *
 * 本脚本量化「直出图集」是否真的可被代码直接消费：
 *   S1 切格可用   角色是否完整落在各自象限内（不越界、不跨格）
 *   S2 格子对齐   角色包围盒中心与象限中心的偏移（越小越可直接按格切）
 *   S3 尺度一致   各格角色包围盒尺寸的离散度（一致则可共用一套缩放/锚点）
 *   S4 角色一致   各格调色板重合度（同一角色的核心判据）
 *   S5 抠底可用   各格能否安全抠底
 *
 * 用法：node verify/pet-sprite/check-sprite-sheet.mjs <sheet.png> [cols] [rows]
 */

import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cutout, alphaBBox, estimateBackground, colorDistance } from './lib/cutout.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVIDENCE = join(HERE, '..', '..', 'docs', 'test', 'pet-sprite', 'evidence')

const SHEET = process.argv[2]
const COLS = Number(process.argv[3] ?? 2)
const ROWS = Number(process.argv[4] ?? 2)
const CELL_LABELS = ['左上', '右上', '左下', '右下', '中上', '中下']

function paletteOf(img, topN = 20) {
  const counts = new Map()
  let total = 0
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4
      if (img.data[i + 3] < 230) continue
      const k = ((img.data[i] >> 3) << 10) | ((img.data[i + 1] >> 3) << 5) | (img.data[i + 2] >> 3)
      counts.set(k, (counts.get(k) ?? 0) + 1)
      total++
    }
  }
  const unq = (k) => [((k >> 10) & 31) << 3, ((k >> 5) & 31) << 3, (k & 31) << 3]
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
    .map(([k, n]) => ({ rgb: unq(k), share: total ? n / total : 0 }))
}

function paletteOverlap(pa, pb, tol = 40) {
  let hit = 0, sum = 0
  for (const c of pa) {
    sum += c.share
    if (pb.some((d) => colorDistance(c.rgb, d.rgb) <= tol)) hit += c.share
  }
  return sum > 0 ? hit / sum : 0
}

/** 判断角色是否越出自己象限：检查象限边界外侧一圈是否有非背景像素 */
function bleedCheck(cell, cw, ch, bg, tol = 30) {
  const band = 3
  let bleed = 0
  const isChar = (x, y) => {
    if (x < 0 || x >= cw || y < 0 || y >= ch) return false
    const i = (y * cw + x) * 4
    return colorDistance([cell[i], cell[i + 1], cell[i + 2]], bg) > tol
  }
  // 四条边界带
  for (let x = 0; x < cw; x++) {
    for (let d = 0; d < band; d++) {
      if (isChar(x, d)) bleed++
      if (isChar(x, ch - 1 - d)) bleed++
    }
  }
  for (let y = 0; y < ch; y++) {
    for (let d = 0; d < band; d++) {
      if (isChar(d, y)) bleed++
      if (isChar(cw - 1 - d, y)) bleed++
    }
  }
  return bleed
}

async function main() {
  if (!SHEET) {
    console.error('用法: node check-sprite-sheet.mjs <sheet.png> [cols] [rows]')
    process.exit(1)
  }
  await mkdir(EVIDENCE, { recursive: true })

  console.log('=== 直出图集验证：一次生成多姿态 ===')
  console.log(`  ${SHEET}`)
  console.log('')

  const { data, info } = await sharp(SHEET).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const CW = Math.floor(info.width / COLS)
  const CH = Math.floor(info.height / ROWS)
  console.log(`  图集 ${info.width}×${info.height} → ${COLS}×${ROWS} 格，每格 ${CW}×${CH}`)
  console.log('')

  const cells = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const buf = Buffer.alloc(CW * CH * 4)
      for (let y = 0; y < CH; y++) {
        const srcOff = ((r * CH + y) * info.width + c * CW) * 4
        data.copy(buf, y * CW * 4, srcOff, srcOff + CW * 4)
      }
      const bg = estimateBackground(buf, CW, CH)
      const res = cutout(buf, CW, CH, bg)
      const bbox = alphaBBox(res.data, CW, CH)
      const idx = r * COLS + c
      cells.push({
        idx, r, c, bg, tuning: res.tuning, bbox,
        img: { data: res.data, w: CW, h: CH },
        bleed: bleedCheck(buf, CW, CH, bg),
        palette: paletteOf({ data: res.data, w: CW, h: CH }),
        raw: buf,
      })
      await sharp(res.data, { raw: { width: CW, height: CH, channels: 4 } })
        .png().toFile(join(EVIDENCE, `sheet-cell-${r}${c}-cutout.png`))
    }
  }

  // ---- S1 切格可用（不越界）----
  console.log('[S1] 切格可用性（角色是否越出自己象限）')
  let s1 = true
  for (const c of cells) {
    const ok = c.bleed === 0
    if (!ok) s1 = false
    console.log(`     ${CELL_LABELS[c.idx] ?? c.idx}  边界带非背景像素 ${String(c.bleed).padStart(5)}   ${ok ? '✓' : '✗ 有越界'}`)
  }
  console.log(`     ${s1 ? '✓ PASS 四格角色均未越界' : '✗ FAIL 存在跨格'}`)
  console.log('')

  // ---- S2 格子对齐 ----
  console.log('[S2] 格子对齐（角色包围盒中心 vs 象限中心）')
  let s2 = true
  for (const c of cells) {
    if (!c.bbox) { s2 = false; continue }
    const cx = c.bbox.minX + c.bbox.w / 2
    const cy = c.bbox.minY + c.bbox.h / 2
    const dx = cx - CW / 2
    const dy = cy - CH / 2
    const off = Math.hypot(dx, dy) / Math.min(CW, CH)
    if (off > 0.12) s2 = false
    console.log(
      `     ${CELL_LABELS[c.idx] ?? c.idx}  包围盒 ${c.bbox.w}×${c.bbox.h}  中心偏移 (${dx.toFixed(0)},${dy.toFixed(0)}) = 格宽 ${(off * 100).toFixed(1)}%   ${off <= 0.12 ? '✓' : '✗'}`,
    )
  }
  console.log(`     ${s2 ? '✓ PASS 各格角色基本居中' : '✗ FAIL 偏移过大，不能按固定格切'}`)
  console.log('')

  // ---- S3 尺度一致 ----
  console.log('[S3] 尺度一致性（各格角色包围盒尺寸）')
  const areas = cells.filter((c) => c.bbox).map((c) => c.bbox.w * c.bbox.h)
  const meanArea = areas.reduce((s, v) => s + v, 0) / areas.length
  const areaSpread = (Math.max(...areas) - Math.min(...areas)) / meanArea
  const s3 = areaSpread < 0.5
  console.log(`     包围盒面积 ${areas.map((a) => a.toLocaleString()).join(' / ')}`)
  console.log(`     相对离散度 ${(areaSpread * 100).toFixed(1)}%（阈值 50%）   ${s3 ? '✓ PASS' : '✗ FAIL 各格尺度差异大'}`)
  console.log('')

  // ---- S4 角色一致 ----
  console.log('[S4] 角色一致性（各格调色板两两重合度）')
  let s4 = true
  const overlaps = []
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const ab = paletteOverlap(cells[i].palette, cells[j].palette)
      const ba = paletteOverlap(cells[j].palette, cells[i].palette)
      const both = Math.min(ab, ba)
      overlaps.push({ pair: `${i}-${j}`, both })
      if (both < 0.8) s4 = false
    }
  }
  const minOv = Math.min(...overlaps.map((o) => o.both))
  console.log(`     最低双向重合度 ${(minOv * 100).toFixed(1)}%（阈值 80%）   ${s4 ? '✓ PASS 四格配色同源' : '✗ FAIL 配色不一致'}`)
  console.log('')

  // ---- S5 抠底可用 ----
  console.log('[S5] 抠底可用性')
  let s5 = true
  for (const c of cells) {
    const cov = c.bbox ? (c.bbox.w * c.bbox.h) / (CW * CH) : 1
    const ok = cov < 0.9
    if (!ok) s5 = false
    const hex = '#' + c.bg.map((v) => v.toString(16).padStart(2, '0')).join('')
    console.log(`     ${CELL_LABELS[c.idx] ?? c.idx}  底色 ${hex}  tSolid=${c.tuning.tSolid}（泄漏点 ${c.tuning.leakAt ?? '—'}）  掩膜占格 ${(cov * 100).toFixed(1)}%   ${ok ? '✓' : '✗'}`)
  }
  console.log(`     ${s5 ? '✓ PASS' : '✗ FAIL'}`)
  console.log('')

  // ---- 产出并排对比 ----
  const CELL = 300
  const strip = Buffer.alloc(CELL * COLS * CELL * ROWS * 4)
  for (let y = 0; y < CELL * ROWS; y++) {
    for (let x = 0; x < CELL * COLS; x++) {
      const v = ((x >> 3) + (y >> 3)) % 2 === 0 ? 235 : 210
      const i = (y * CELL * COLS + x) * 4
      strip[i] = v; strip[i + 1] = v; strip[i + 2] = v; strip[i + 3] = 255
    }
  }
  for (const c of cells) {
    if (!c.bbox) continue
    const { data: cd, info: ci } = await sharp(c.img.data, { raw: { width: c.img.w, height: c.img.h, channels: 4 } })
      .extract({ left: c.bbox.minX, top: c.bbox.minY, width: c.bbox.w, height: c.bbox.h })
      .resize(CELL - 24, CELL - 24, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw().toBuffer({ resolveWithObject: true })
    const ox = c.c * CELL + 12, oy = c.r * CELL + 12
    for (let y = 0; y < ci.height; y++) {
      for (let x = 0; x < ci.width; x++) {
        const si = (y * ci.width + x) * 4
        const al = cd[si + 3] / 255
        if (al === 0) continue
        const di = ((oy + y) * CELL * COLS + ox + x) * 4
        for (let k = 0; k < 3; k++) strip[di + k] = Math.round(cd[si + k] * al + strip[di + k] * (1 - al))
      }
    }
  }
  const stripPath = join(EVIDENCE, 'sheet-poses-comparison.png')
  await sharp(strip, { raw: { width: CELL * COLS, height: CELL * ROWS, channels: 4 } })
    .png().toFile(stripPath)

  const all = s1 && s2 && s3 && s4 && s5
  // 三态判定：
  //   直用     —— 连格子对齐与尺度都一致，可免归一化按固定格切
  //   需归一化 —— 角色一致且不越界，但各格取景/尺度不同，须逐格抠底求包围盒后按共同地线对齐
  //   不可用   —— 角色不一致或越界，切出来不是同一个角色
  const usable = s1 && s4 && s5
  const verdict = all
    ? '✓ 可直用（免归一化，按固定格切即可）'
    : usable
      ? '◐ 可用，但必须逐格归一化'
      : '✗ 不可用'
  console.log('─'.repeat(72))
  console.log(`直出图集判定：${verdict}`)
  console.log(`  S1 切格可用   ${s1 ? '✓' : '✗'}   （不越界 —— 可安全按格切，这是硬要求）`)
  console.log(`  S4 角色一致   ${s4 ? '✓' : '✗'}  （最低重合度 ${(minOv * 100).toFixed(1)}% —— 硬要求）`)
  console.log(`  S5 抠底可用   ${s5 ? '✓' : '✗'}   （硬要求）`)
  console.log(`  S2 格子对齐   ${s2 ? '✓' : '✗'}   （软要求：不满足则需按包围盒重新定位）`)
  console.log(`  S3 尺度一致   ${s3 ? '✓' : '✗'}   （软要求：不满足则需按共同地线重新定尺度）`)
  console.log('')
  if (usable) {
    console.log('  说明：S2/S3 不达标**不影响可用性**。精灵流水线本就要求逐格处理——')
    console.log('       抠底 → 求包围盒 → 按共同地线/锚点对齐（该步骤已在验证点 A3 得到验证，误差 0px）。')
    console.log('       模型能把「同一角色的多个姿态」放进四格且不越界，已经满足更关键的 S1/S4。')
  }
  console.log('')
  console.log(`四格并排图：${stripPath}`)

  await writeFile(
    join(EVIDENCE, 'check-sprite-sheet-result.json'),
    JSON.stringify({
      all, usable, verdict, s1, s2, s3, s4, s5, minOverlap: minOv, areaSpread,
      grid: { cols: COLS, rows: ROWS, cellW: CW, cellH: CH },
      cells: cells.map((c) => ({
        idx: c.idx, bg: c.bg, bbox: c.bbox, bleed: c.bleed,
        tSolid: c.tuning.tSolid, leakAt: c.tuning.leakAt,
      })),
    }, null, 2) + '\n',
    'utf-8',
  )

  process.exit(usable ? 0 : 1)
}

main().catch((e) => { console.error('[check-sprite-sheet] 失败:', e); process.exit(1) })
