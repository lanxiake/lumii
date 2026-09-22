/**
 * measure-ground.mjs — 量每一行的地线：**锚点到底落在谁的脚底**
 *
 * 切图期 `import-shimeji.mjs` 取 `groundY = 所有用到的帧的最大 y1` 当锚点。这个脚本把
 * 每一行各自的 y1 摊开，用来回答两类问题：
 *
 *   · 站姿会不会悬空——某行（Picked/Fall/Crawl 之类）的内容比站姿更低的话，
 *     锚点会被那一行拉下去，而站姿的脚底高于锚点
 *   · 攀爬留白（`perchGaps`）对不对——CLIMB/CRAWL 两行的内容离地多远
 *
 * **它是为一次悬空排查写出来的**（2026-09-22，用户报「宠物悬空运动」）。那次的结论是
 * **假设不成立**：五只猫的 STAND/WALK/REST 三个地线行 y1 全部等于并集地线（127/127），
 * 锚点就在脚底；真正的原因是驱动的"地面线"跟着宠物漂移了
 * （见 `PetWanderDriver.groundY()`）。
 *
 * 留在仓库里是因为它正是下次遇到"悬空"时该先跑的一步：**先排除素材，再去查驱动**。
 *
 * 用法：node measure-ground.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { SHEET_DIR, CELL, ROWS, DECLARED, GROUPS } from './shimeji-sheet.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const require = createRequire(path.join(REPO, 'package.json'))
const sharp = require('sharp')

const files = fs
  .readdirSync(SHEET_DIR)
  .filter((f) => f.toLowerCase().endsWith('.png'))
  .sort()

const USED = [...new Set(GROUPS.map((g) => g.from))]

/** 这一行用到的帧的并集包围盒（格内坐标） */
function rowBounds(data, W, C, row, frames) {
  let x0 = 1e9
  let x1 = -1
  let y0 = 1e9
  let y1 = -1
  for (let c = 0; c < frames; c++) {
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const px = c * CELL + x
        const py = row * CELL + y
        if (data[(py * W + px) * C + (C - 1)] > 8) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
  }
  return { x0, x1, y0, y1 }
}

for (const f of files) {
  const { data, info } = await sharp(path.join(SHEET_DIR, f))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: C } = info
  if (W % CELL || H % CELL) continue

  const per = {}
  for (const from of USED) {
    const r = ROWS[from]
    const b = rowBounds(data, W, C, r, DECLARED[from])
    per[from] = b
  }
  const unionY1 = Math.max(...USED.map((k) => per[k].y1))
  const stand = per.STAND.y1

  console.log(`\n=== ${f} ===`)
  for (const k of USED) {
    const b = per[k]
    const mark = b.y1 === unionY1 ? '  ← 地线由它决定' : ''
    console.log(
      `  ${k.padEnd(6)} row=${ROWS[k]} y0=${String(b.y0).padStart(3)} y1=${String(b.y1).padStart(3)}` +
        `  离地线 ${String(unionY1 - b.y1).padStart(3)}px${mark}`,
    )
  }
  const gapPx = unionY1 - stand
  console.log(
    `  地线 uy1=${unionY1}；STAND 脚底 y1=${stand} → 站姿离锚点 ${gapPx}px` +
      `（画布 128 → 比例 ${(gapPx / 128).toFixed(4)}）`,
  )
}
