#!/usr/bin/env node
/**
 * make-ref.mjs — 从 Shimeji 表裁一行，拼成**和 AI 出图同构**的参考图
 *
 * ## 为什么参考图要重排
 *
 * Shimeji 表是 8×9 的大网格，一格 128px。直接把它丢给生图模型当参考，
 * 有两个问题：**格子太小**（模型看到的是九行密密麻麻的小人）与**格式不对应**
 * （模型要出的是一张 2×2 的图，参考图却是 9 行）。
 *
 * 所以按**目标格式**重排：取一行里的前 N 格，拼成 2×2 或 4×1，铺上目标背景色，
 * 再放大到生图能看清的尺寸。参考图与出图**同构**，模型才是在"照着填"而不是"猜"。
 *
 * ## 背景色是刻意的
 *
 * 铺的是**目标背景色**（默认 `#00ffff`，与 `plans.json` 一致）而不是透明或白。
 * 同构的另一半：参考图连"背景长什么样"都示范了一遍，不必指望文字描述被遵守。
 *
 * ## 它回答不了的事
 *
 * 实测过「**参考图压过文字提示**」（§3.2 验证点 D，3 跳后 IoU 73%），
 * 所以拿一只像素风的猫当参考，出的图**很可能也是那只猫**。想要姿态就必然带上画风，
 * 这两件事在这个链路上分不开——这个脚本只负责把姿态喂准，分不分得开由实验说了算。
 *
 * 用法：
 *   node make-ref.mjs <表文件名> <行名> [--n 4] [--layout 2x2|4x1] [--bg #00ffff]
 *                      [--scale 4] [--out outputs/pet-raw/ref.png] [--list]
 *   node make-ref.mjs shimeji_caneko.png WALK
 *   node make-ref.mjs --list                     # 列出所有表与行名
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { SHEET_DIR, CELL, ROWS, DECLARED } from './shimeji-sheet.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const sharp = createRequire(path.join(REPO, 'package.json'))('sharp')
const WORKSPACE = path.join(os.homedir(), '.lumii/workspace')

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? dflt : args[i + 1]
}
const has = (name) => args.includes(`--${name}`)
/** 位置参数：跳开 `--名 值` 这类成对出现的选项（`--list` 这种开关不吃值） */
const VALUED = new Set(['n', 'layout', 'bg', 'scale', 'out'])
const pos = []
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    if (VALUED.has(args[i].slice(2))) i++
    continue
  }
  pos.push(args[i])
}

if (has('list') || args.length === 0) {
  const sheets = fs.existsSync(SHEET_DIR)
    ? fs.readdirSync(SHEET_DIR).filter((f) => f.startsWith('shimeji_') && f.endsWith('.png'))
    : []
  console.log(`表目录：${SHEET_DIR}${sheets.length ? '' : '（不存在）'}`)
  for (const f of sheets) console.log(`  ${f}`)
  console.log(`\n行名（1 起是表上的行号）：`)
  for (const [k, v] of Object.entries(ROWS)) console.log(`  ${k}  第 ${v + 1} 行  声明 ${DECLARED[k]} 帧`)
  process.exit(0)
}

const [sheetName, rowName] = pos
if (!sheetName || !rowName) throw new Error('用法：node make-ref.mjs <表文件名> <行名>（--list 看有哪些）')
const row = ROWS[rowName.toUpperCase()]
if (row === undefined) throw new Error(`未知行名 ${rowName}，可选：${Object.keys(ROWS).join(' ')}`)

const n = Number(opt('n', Math.min(4, DECLARED[rowName.toUpperCase()])))
const layout = opt('layout', '2x2')
const [lc, lr] = layout.split('x').map(Number)
const bg = opt('bg', '#00ffff')
const scale = Number(opt('scale', 4))
const out = path.join(WORKSPACE, opt('out', `outputs/pet-raw/ref-${path.basename(sheetName, '.png')}-${rowName.toLowerCase()}.png`))

if (lc * lr < n) throw new Error(`布局 ${layout} 只有 ${lc * lr} 格，装不下 ${n} 帧`)

const src = path.join(SHEET_DIR, sheetName)
if (!fs.existsSync(src)) throw new Error(`原表不存在：${src}`)

/**
 * 每格**先压平、再放大**，最后才拼。
 *
 * 顺序改过一次，两次都踩了：
 * - 先拼到透明底再整体 `flatten` → 得到一张纯背景色的空图（内容全丢）
 * - 先拼再整体 `resize(4×)`     → 画布变成 1024，**内容还是原来那么大**
 *   （实测：四格拼装 5645 个非背景像素，resize 到 4 倍后仍是 5645；
 *    而同一张图单独 resize 是正常的 1395→22320）
 *
 * 每一步都做在该做的那张图上，就不必猜 sharp 的 pipeline 什么时候合并、什么时候不合并。
 * 末尾那道哨兵是给这几次踩坑擦屁股的——它会在图是空的时候当场炸掉，
 * 而不是让实验静默地变成"其实没挂参考图"。
 */
const tiles = []
for (let i = 0; i < n; i++) {
  tiles.push(
    await sharp(src)
      .extract({ left: i * CELL, top: row * CELL, width: CELL, height: CELL })
      .flatten({ background: bg })
      .resize(CELL * scale, CELL * scale, { kernel: 'nearest' })
      .png()
      .toBuffer(),
  )
}

const tw = CELL * scale
const cw = tw * lc
const ch = tw * lr
fs.mkdirSync(path.dirname(out), { recursive: true })
await sharp({ create: { width: cw, height: ch, channels: 4, background: bg } })
  .composite(tiles.map((input, i) => ({ input, left: (i % lc) * tw, top: Math.floor(i / lc) * tw })))
  .png()
  .toFile(out)

// 哨兵：图里必须真的有东西。空参考图不会报错，只会让那一轮实验静默地变成"没挂参考"
const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
const bgRgb = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16))
let ink = 0
for (let i = 0; i < data.length; i += info.channels) {
  const d = Math.abs(data[i] - bgRgb[0]) + Math.abs(data[i + 1] - bgRgb[1]) + Math.abs(data[i + 2] - bgRgb[2])
  if (d > 60) ink++
}
const inkPct = (ink / (info.width * info.height)) * 100
if (inkPct < 1) throw new Error(`参考图上只有 ${inkPct.toFixed(2)}% 的像素不是背景——内容没画进去，别拿去当参考`)

const rel = path.relative(WORKSPACE, out).replace(/\\/g, '/')
console.log(`${path.basename(src)} 第 ${row + 1} 行（${rowName}）前 ${n} 格 → ${layout} → ${cw}×${ch}（每格 ${tw}px，内容占 ${inkPct.toFixed(1)}%）`)
console.log(`参考图（工作区相对路径，直接给 Agent 的 referenceImagePaths 用）：\n  ${rel}`)
