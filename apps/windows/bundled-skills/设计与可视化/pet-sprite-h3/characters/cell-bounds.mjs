#!/usr/bin/env node
/**
 * cell-bounds.mjs — 逐格量：内容包围盒 / 越界 / 顶空 / 升幅
 *
 * 用法：
 *   node cell-bounds.mjs <表目录|f0000.png> [更多...]
 *
 * ## 为什么出表后要先跑它，再谈装包
 *
 * **越出格线不可逆**——模型生成时就把画面上半部分丢了，本地怎么挪位、怎么缩小，
 * 都只是把平头从画框边挪进画面里（实测：一张 6 格、一张 8 格头顶出格，
 * 切口第 0 行上的平头宽 84~111px，削掉的是**耳朵连举起的手**）。
 *
 * 而装包闸门（S1）是按"边界带里有多少不透明像素"判的——**被拒的批次连包都进不去**，
 * 而那时渲染的几十分钟已经花掉了。所以这个预检要放在**出表之后、装包之前**。
 *
 * ## 判据与装包闸门同口径
 *
 * 距画框 ≤ `BAND`(2px) 的边界带内、alpha > `ALPHA`(40) 的像素占比 > `OVER_PCT`(0.5%)
 * 即判该格越界；**任一格越界，整批会被拒**。
 *
 * ## ⚠ 「顶边起伏」不等于"她升了多少"
 *
 * 它是 tops 的极差，姿势变化（举手、跳、低头）也会改包围盒顶。
 * 要判"有没有真的在画面里做长途位移"，得**配合底边（脚）一起看**：
 * 顶和底同向移动才是位移，只有顶动是姿势。
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const BAND = 2
const ALPHA = 40
const OVER_PCT = 0.5

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('用法：node cell-bounds.mjs <表目录|f0000.png> [更多...]')
  process.exit(2)
}

for (const arg of args) {
  const png = arg.endsWith('.png') ? arg : path.join(arg, 'f0000.png')
  if (!fs.existsSync(png)) {
    console.log(`（跳过 ${arg}：找不到 ${png}）`)
    continue
  }
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H } = info
  // cols 存在拼条时写下的同名 json 里（stage/h3-motion 出表时落的）。
  // 缺了就退回 16 —— 这时格子宽度可能不对，所以下面把 cols 打出来给人看。
  const jsonPath = png.replace(/\.png$/, '.json')
  let cols = 16
  try {
    cols = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')).cols || 16
  } catch {
    console.log(`  ⚠ 读不到 ${path.basename(jsonPath)}，按 cols=16 算`)
  }
  const cw = Math.floor(W / cols)
  if (W % cols !== 0) console.log(`  ⚠ 宽 ${W} 不是 ${cols} 的整数倍，末格可能有零头`)

  console.log(
    `\n══ ${path.basename(path.dirname(png))}  ${cols}格×${cw}px  ` +
      `越界判定：${BAND}px 边界带内 alpha>${ALPHA} 的像素占比 > ${OVER_PCT}% 即判越界（装包闸门口径）`,
  )

  const tops = []
  const bots = []
  const lefts = []
  const rights = []
  let over = 0
  for (let c = 0; c < cols; c++) {
    let minX = cw
    let minY = H
    let maxX = -1
    let maxY = -1
    let bandHit = 0
    let bandN = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < cw; x++) {
        const a = data[(y * W + c * cw + x) * 4 + 3]
        const inBand = x < BAND || x >= cw - BAND || y < BAND || y >= H - BAND
        if (inBand) {
          bandN++
          if (a > ALPHA) bandHit++
        }
        if (a > ALPHA) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    const pct = (bandHit / bandN) * 100
    const bad = pct > OVER_PCT
    if (bad) over++
    tops.push(minY)
    bots.push(maxY)
    lefts.push(minX)
    rights.push(maxX)
    console.log(
      `  格${String(c).padStart(2)} 内容 x ${String(minX).padStart(3)}~${String(maxX).padStart(3)}` +
        ` y ${String(minY).padStart(3)}~${String(maxY).padStart(3)}` +
        `  顶空 ${String(minY).padStart(3)}  底空 ${String(H - 1 - maxY).padStart(3)}` +
        `  越界 ${pct.toFixed(2)}%${bad ? '  ✗' : ''}`,
    )
  }
  const topSpan = Math.max(...tops) - Math.min(...tops)
  const botSpan = Math.max(...bots) - Math.min(...bots)
  const heights = bots.map((b, i) => b - tops[i])
  const hSpan = Math.max(...heights) - Math.min(...heights)
  const swingX = Math.max(...rights) - Math.min(...lefts)
  console.log(`  → 越界格 ${over}/${cols}${over ? '  ✗ 这批会被装包闸门整批拒绝' : '  ✓ 全在界内'}`)
  console.log(
    `  → 顶边移动 ${topSpan}px｜底边移动 ${botSpan}px｜内容高变化 ${hSpan}px` +
      `（顶空最小 ${Math.min(...tops)}）｜右缘摆幅 ${swingX}px`,
  )
  console.log('     顶、底移动幅度接近而内容高变化小 ⇒ 整体位移（真位移该归客户端）')
  console.log('     内容高变化大 ⇒ 姿势在变（举手/跳/蹲），不是位移')
}
