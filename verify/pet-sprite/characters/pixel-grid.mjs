#!/usr/bin/env node
/**
 * pixel-grid.mjs — 像素图 ↔ 索引网格文本，让我能真正「编辑像素」
 *
 * ## 为什么要有它
 *
 * 本机 Read 工具读不了图（见记忆），而「编辑像素图」要求的是**逐像素的读写**，
 * 不是"看一眼大概"。ASCII 预览（`pixel-ascii.mjs`）只能看形状疏密，改不了；
 * 这个工具把图摊成纯文本，每个像素一个字符，改完再写回去。
 *
 * 这是像素画的真实工作形态——像素画本来就是在网格上改格子，只不过别人的格子
 * 是鼠标点的，我的是文本。
 *
 * ## 文本格式
 *
 * ```
 * size 64 64
 * palette 010303 fca028 fcb892 …        # 索引 1 起；每项 6 位十六进制
 * ....1111....                          # 网格：'.' = 透明
 * ...122221...                          #        1-9a-z = 调色板上第 N 色
 * ```
 *
 * `size` 与 `palette` 两行是头部，其余行是网格（每行一个像素行，**不补空格**——
 * 尾部透明像素省略，读回时补 `.`，这样文本不会拖一屁股点）。
 *
 * 用法：
 *   node pixel-grid.mjs to-text <png> [--out <txt>] [--crop]
 *   node pixel-grid.mjs to-png  <txt> <png>
 *
 * `--crop` 只导出内容包围盒那一块——改动作帧时大半画布是空的，
 * 裁掉能省掉三分之二的阅读量。写回时用 `--at x,y` 摆回原位置。
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('C:/myself/projects/my/open-source/lumii/package.json')
const sharp = require('sharp')

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
const ALPHA_MIN = 8

async function readPng(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, W: info.width, H: info.height }
}

/** 收集不透明像素的颜色 → 调色板（按出现次数降序，出现最多的排第 1） */
function buildPalette(data, W, H) {
  const hist = new Map()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= ALPHA_MIN) continue
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    hist.set(key, (hist.get(key) ?? 0) + 1)
  }
  return [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
}

function hexOf(key) {
  return key.toString(16).padStart(6, '0')
}

async function toText(png, out, crop) {
  const { data, W, H } = await readPng(png)
  const palette = buildPalette(data, W, H)
  if (palette.length > DIGITS.length) {
    throw new Error(`颜色太多（${palette.length}）——先量化到 ${DIGITS.length} 色以内再转文本`)
  }
  const index = new Map(palette.map((k, i) => [k, i]))

  let x0 = 0
  let y0 = 0
  let x1 = W - 1
  let y1 = H - 1
  if (crop) {
    x0 = W
    y0 = H
    x1 = -1
    y1 = -1
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] <= ALPHA_MIN) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    if (x1 < 0) throw new Error('整张全透明')
  }
  const cw = x1 - x0 + 1
  const ch = y1 - y0 + 1

  const lines = [`size ${cw} ${ch}`]
  if (crop) lines.push(`at ${x0} ${y0}`)
  lines.push(`palette ${palette.map(hexOf).join(' ')}`)
  for (let y = y0; y <= y1; y++) {
    let row = ''
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4
      row += data[i + 3] <= ALPHA_MIN ? '.' : DIGITS[index.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])]
    }
    lines.push(row.replace(/\.+$/, '')) // 尾部透明省略
  }

  const text = lines.join('\n') + '\n'
  if (out) {
    fs.writeFileSync(out, text, 'utf-8')
    console.log(`✓ ${out}  ${cw}×${ch}  ${palette.length} 色`)
  } else {
    console.log(text)
  }
}

async function toPng(txt, png, atArg) {
  const raw = fs.readFileSync(txt, 'utf-8').split(/\r?\n/)
  let size = null
  let at = null
  let palette = null
  let inBody = false
  const rows = []
  // ⚠ 只认头部三行；`palette` 之后**每一行都是网格**，包括全透明的空行。
  // 早先写成"跳过空行"，而角色在画布里常常上下都留白（本站的猫占行 4-59），
  // 开头那几行空行被吃掉后整张图会**向上错位**，报出来的却是"行数不符"。
  for (const line of raw) {
    if (line.startsWith('size ')) {
      size = line.slice(5).trim().split(/\s+/).map(Number)
    } else if (line.startsWith('at ')) {
      at = line.slice(3).trim().split(/\s+/).map(Number)
    } else if (line.startsWith('palette ')) {
      palette = line
        .slice(8)
        .trim()
        .split(/\s+/)
        .map((h) => parseInt(h, 16))
      inBody = true
    } else if (inBody) {
      rows.push(line)
    }
  }
  if (!size || !palette) throw new Error('文本缺 size 或 palette 头')
  const [cw, ch] = size
  while (rows.length > ch) rows.pop() // 末尾换行 split 出的空行
  if (rows.length !== ch) {
    throw new Error(`网格行数 ${rows.length} 与 size 的高 ${ch} 不符（少了就是文件被截断或空行被过滤掉了）`)
  }

  const [ax, ay] = atArg
    ? atArg.split(',').map(Number)
    : at
      ? at
      : [0, 0]
  // 画布尺寸：摆了偏移就用它推，否则就正好是网格大小
  const W = ax + cw
  const H = ay + ch

  const buf = Buffer.alloc(W * H * 4, 0)
  for (let y = 0; y < ch; y++) {
    const row = rows[y]
    if (row.length > cw) throw new Error(`第 ${y + 1} 行有 ${row.length} 个字符，超过宽度 ${cw}`)
    for (let x = 0; x < cw; x++) {
      const c = row[x] ?? '.'
      if (c === '.' || c === ' ') continue
      const idx = DIGITS.indexOf(c)
      if (idx < 0) throw new Error(`第 ${y + 1} 行第 ${x + 1} 列有未知字符「${c}」`)
      if (idx >= palette.length) throw new Error(`字符「${c}」指向第 ${idx + 1} 色，但调色板只有 ${palette.length} 色`)
      const key = palette[idx]
      const i = ((y + ay) * W + (x + ax)) * 4
      buf[i] = (key >> 16) & 0xff
      buf[i + 1] = (key >> 8) & 0xff
      buf[i + 2] = key & 0xff
      buf[i + 3] = 255
    }
  }
  await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toFile(png)
  console.log(`✓ ${png}  ${W}×${H}（网格 ${cw}×${ch} @ ${ax},${ay}）`)
}

const [cmd, a, b] = process.argv.slice(2)
const flags = process.argv.slice(2).filter((x) => x.startsWith('--'))
if (cmd === 'to-text') {
  const oi = flags.indexOf('--out')
  await toText(a, oi >= 0 ? process.argv[process.argv.indexOf('--out') + 1] : null, flags.includes('--crop'))
} else if (cmd === 'to-png') {
  const ai = flags.findIndex((f) => f.startsWith('--at'))
  await toPng(a, b, ai >= 0 ? flags[ai].slice(5) || process.argv[process.argv.indexOf(flags[ai]) + 1] : null)
} else {
  throw new Error('用法：pixel-grid.mjs to-text <png> [--out txt] [--crop] | to-png <txt> <png> [--at x,y]')
}
