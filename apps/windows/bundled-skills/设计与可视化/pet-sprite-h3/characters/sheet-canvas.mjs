#!/usr/bin/env node
/**
 * sheet-canvas.mjs — 量一批动作表，算出**画布该开多宽**
 *
 * ## 为什么需要它（这条规则不能靠推）
 *
 * 客户端归一化的规则是 `scale = canvas.h × 0.94 / 该组最高的包围盒`，而
 * **「组」= 帧尺寸相同的一组**（同一批出图切出来的格一样大 → 同一组）。
 * 于是：
 *
 *   归一化后某帧的宽度 = 该帧包围盒宽 × (canvas.h × 0.94 / 组内最高包围盒)
 *
 * 关键在**分母是"组内最高"而不是"这一帧自己的高"**。所以：
 *
 *  · 姿势越矮，归一化的倍率**不会**把它补上来——它跟着组里最高的那个走，
 *    矮姿势在屏幕上就是小的（这是刻意的：逐帧各自撑满会让蹲下的帧被放大到
 *    和站直一样高，切动作看起来像在抽搐）。
 *  · 因此**同一个角色若把正面与侧身放进同一组，两者会互相牵制**；而本项目
 *    正面表是 576 宽出图、侧身表是 768 宽出图，切出来的格尺寸不同 → 天然分成
 *    两组，各自归一。
 *  · 更要命的是：**往组里加一个更高的动作，会让整组变小、所需宽度变窄**。
 *    所以不能拿单个姿势的宽高比去乘 421 了事——那个数偏大，且会随批次变动。
 *
 * 超宽会被**横向裁掉**，而 `pet-creator/run.ts` 只记一条 `clipped` 警告、不报错。
 * 判据只能是**量已经出好的表**。
 *
 * ## 两侧余量要分开算（重心对齐）
 *
 * 客户端默认按**重心**对齐：落位是 `x = anchor[0] − cx × scale`，而 anchor 在画布
 * 水平中央。所以左边要装下 `(cx − minX) × scale`、右边要装下 `(maxX − cx) × scale`
 * ——角色质量偏在一侧时（侧身带尾巴）两者差得不小，**只看包围盒宽度会低估**。
 * 本工具因此算的是重心口径，并把包围盒口径一起打出来做对照。
 *
 * ## 阈值必须跟客户端一致
 *
 * `computeNormalize` 的 `bboxThreshold` 默认 **128**，所以这里也用 128。
 * 用 16 会把描边的抗锯齿也算进去，量出来的包围盒偏大、算出的画布偏宽。
 *
 * 用法：
 *   node sheet-canvas.mjs --dir <动作表根目录> [--char tuanzi] [--canvas-h 448]
 *   node sheet-canvas.mjs --dir <动作表根目录> --canvas 448x448   # 顺带查现有画布装不装得下
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { alphaBBox, alphaCentroidX } from '../lib/cutout.mjs'

/** 与客户端 `computeNormalize` 的 bboxThreshold 保持一致（见头注释） */
const BBOX_THRESHOLD = 128
const FIT = 0.94

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}

const root = opt('dir')
if (!root) {
  console.error('用法：node sheet-canvas.mjs --dir <动作表根目录> [--char 角色] [--canvas-h 448] [--canvas 448x448]')
  process.exit(1)
}
const charFilter = opt('char', '')
const canvasH = Number(opt('canvas-h', 448))
const cols = Number(opt('cols', 8))
const targetH = canvasH * FIT

/** 量一张表：返回每格的包围盒 */
async function measureSheet(file) {
  const meta = await sharp(file).metadata()
  const cw = Math.floor(meta.width / cols)
  const ch = meta.height
  // 整张读一次再自己切格，别每格调一次 sharp（几十次解码没必要）
  const { data } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = meta.width
  const cells = []
  for (let c = 0; c < cols; c++) {
    const cell = Buffer.alloc(cw * ch * 4)
    for (let y = 0; y < ch; y++) {
      data.copy(cell, y * cw * 4, (y * W + c * cw) * 4, (y * W + c * cw + cw) * 4)
    }
    const b = alphaBBox(cell, cw, ch, BBOX_THRESHOLD)
    if (!b) continue
    const cx = alphaCentroidX(cell, cw, ch, BBOX_THRESHOLD)
    if (cx === null) continue
    cells.push({ index: c, w: b.w, h: b.h, minX: b.minX, maxX: b.maxX, cx })
  }
  return { file, cellW: cw, cellH: ch, cells }
}

const dirs = fs
  .readdirSync(root)
  .filter((d) => d.endsWith('-sheet') && (!charFilter || d.startsWith(`${charFilter}-`)))
  .sort()

if (!dirs.length) {
  console.error(`在 ${root} 下没找到 <角色>-<动作>-sheet/ 目录`)
  process.exit(1)
}

/** 组键 = 格尺寸。同一组共用一个倍率。 */
const groups = new Map()
for (const d of dirs) {
  const sub = path.join(root, d)
  const png = fs.readdirSync(sub).filter((f) => /\.png$/i.test(f)).sort()[0]
  if (!png) continue
  const m = await measureSheet(path.join(sub, png))
  if (!m.cells.length) continue
  const key = `${m.cellW}x${m.cellH}`
  if (!groups.has(key)) groups.set(key, { cellW: m.cellW, cellH: m.cellH, sheets: [] })
  groups.get(key).sheets.push({ action: d.replace(/^.*?-/, '').replace(/-sheet$/, ''), ...m })
}

console.log(`画布高 ${canvasH} → 归一化后角色高 ${targetH.toFixed(1)}px（fit ${FIT}）\n`)

/**
 * 一组需要多宽。
 *
 * ⚠ **不能只看包围盒宽度。** 客户端默认按**重心**对齐（`horizontalAlign: 'centroid'`），
 * 落位是 `x = anchor[0] − cx × scale`，而 anchor 在画布水平中央——所以两侧余量
 * 是**分开算**的：左边要装下 `(cx − minX) × scale`，右边要装下 `(maxX − cx) × scale`。
 * 角色质量偏在一侧时（侧身带尾巴），这两个数差得不少，按包围盒宽度算会低估。
 */
function needOf(cells, scale) {
  const centroid = 2 * Math.max(...cells.map((c) => Math.max(c.cx - c.minX, c.maxX - c.cx) * scale))
  const bbox = Math.max(...cells.map((c) => c.w)) * scale
  return { centroid, bbox, need: centroid }
}

let needed = 0
for (const [key, g] of groups) {
  const all = g.sheets.flatMap((s) => s.cells)
  const tallest = Math.max(...all.map((c) => c.h))
  const scale = targetH / tallest
  const { centroid, bbox, need } = needOf(all, scale)
  needed = Math.max(needed, need)

  console.log(`组 ${key} —— ${g.sheets.length} 个动作 / ${all.length} 格，共用一个倍率`)
  console.log(`  组内最高包围盒 ${tallest} → 倍率 ${scale.toFixed(3)}`)
  console.log(`  按重心对齐要 ${centroid.toFixed(0)}px 宽；只看包围盒要 ${bbox.toFixed(0)}px（取前者）`)
  for (const s of g.sheets) {
    const t = Math.max(...s.cells.map((c) => c.h))
    const n = needOf(s.cells, scale)
    console.log(
      `    ${s.action.padEnd(10)} 高 ${String(t).padStart(4)}  宽 ${String(Math.max(...s.cells.map((c) => c.w))).padStart(4)}` +
        `  → 归一化后 ${(t * scale).toFixed(0)} 高 × 需 ${n.need.toFixed(0)} 宽`,
    )
  }
  console.log('')
}

/**
 * 推荐宽度 = 够用的最小 16 倍数，**再留一格 16px 的余量**。
 *
 * ⚠ 只取"最小的 16 倍数"实测不够：算出的需求是 524、取 528，看着有 4px 余量，
 * 但装完之后爬行的包围盒**距左边只剩 1px**——客户端落位要 `Math.round`，
 * 加上量的是拼条格、装的是铺底后的格，差个一两像素很正常。
 * **"没被裁"和"离被裁只差 1px"不是一回事**，前者随时会变成后者。
 * 所以多给一格（两侧各 16px）：宽度是免费的，贴边不是。
 */
const recommend = Math.ceil((needed + 32) / 16) * 16
const perSide = (recommend - needed) / 2
console.log(`==> 画布宽至少要 ${needed.toFixed(0)}px`)
console.log(`    推荐 ${recommend}px（16 的倍数，且两侧各留 ≥16px 余量）`)
console.log(`    即 --canvas ${recommend}x${canvasH}  —— 实际两侧余量各 ${perSide.toFixed(0)}px`)
console.log(`    （anchor 在画布中央；余量低于 16px 时，落位的舍入与铺底差异就可能吃掉它）`)

// ---- 可选：查一个具体画布装不装得下 ----
const canvasArg = opt('canvas')
if (canvasArg) {
  const [cw, ch] = canvasArg.split('x').map(Number)
  console.log(`\n检查画布 ${cw}×${ch}（两侧各 ${cw / 2}px）：`)
  let bad = 0
  let tight = 0
  for (const [key, g] of groups) {
    const all = g.sheets.flatMap((s) => s.cells)
    const tallest = Math.max(...all.map((c) => c.h))
    const scale = (ch * FIT) / tallest
    for (const s of g.sheets) {
      const n = needOf(s.cells, scale)
      const margin = (cw - n.need) / 2
      if (margin < 0) {
        bad++
        console.log(
          `  ✗ ${s.action}: 归一化后单侧要 ${(n.need / 2).toFixed(0)}px > 画布单侧 ${cw / 2}px（横向裁掉 ${(-margin).toFixed(0)}px）`,
        )
      } else if (margin < 16) {
        tight++
        console.log(`  ⚠ ${s.action}: 只差 ${margin.toFixed(0)}px 就贴边——没被裁，但舍入一晃就裁了`)
      }
    }
  }
  if (bad) {
    console.log(`  ${bad} 个动作会被裁——按上面的建议开宽一点`)
    process.exitCode = 1
  } else if (tight) {
    console.log(`  ${tight} 个动作余量不足 16px——装得下，但建议按推荐值再开宽一档`)
  } else {
    console.log('  ✓ 都装得下，且余量充足')
  }
}
