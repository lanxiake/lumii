#!/usr/bin/env node
/**
 * sheet-contact-sheet.mjs — 把图集里某一组帧拼成一张对照图，肉眼看清"动的是什么"
 *
 * 场景：量出帧间重心极差 9.2px 但包围盒中心只差 1px，需要区分
 *   (a) 角色整体在左右平移（= 该修的对齐问题）
 *   (b) 角色站定、只是耳朵/尾巴/手在动（= 素材本身的动画，不该修）
 * 数字分不出这两者，看图一眼就分得出。
 *
 * 同时输出每帧的**左边缘/右边缘分别相对第 0 帧的差**：
 * 整体平移时两边同号同幅；部件摆动时两边反号。
 *
 * 用法：node sheet-contact-sheet.mjs <图集png> <图集json> <前缀> <输出png>
 */
import sharp from 'sharp'
import { readFileSync } from 'node:fs'

const [pngPath, jsonPath, prefix, outPath] = process.argv.slice(2)
const idx = JSON.parse(readFileSync(jsonPath, 'utf8'))
const names = Object.keys(idx.frames).filter((n) => n.startsWith(prefix)).sort()

// 每帧裁到内容包围盒（带一点边距），等比缩到统一高度后横排
const CELL_H = 240
const tiles = []
const edges = []
for (const name of names) {
  const f0 = idx.frames[name].frame
  // sharp 要的是 {left,top,width,height}，图集索引里是 {x,y,w,h}
  const f = { left: f0.x, top: f0.y, width: f0.w, height: f0.h }
  const buf = await sharp(pngPath).ensureAlpha().extract(f).png().toBuffer()
  const trimmed = await sharp(buf)
    .trim({ threshold: 1 })
    .resize({ height: CELL_H, fit: 'inside', withoutEnlargement: false })
    .toBuffer()
  const meta = await sharp(trimmed).metadata()
  tiles.push({ buf: trimmed, w: meta.width, h: meta.height, name })

  // 原分辨率下的左右边缘（裁切前）
  const raw = await sharp(pngPath).ensureAlpha().extract(f).raw().toBuffer()
  let left = Infinity
  let right = -Infinity
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      if (raw[(y * f.width + x) * 4 + 3] <= 16) continue
      if (x < left) left = x
      if (x > right) right = x
    }
  }
  edges.push({ name, left, right })
}

const pad = 8
const totalW = tiles.reduce((s, t) => s + t.w + pad, pad)
const H = CELL_H + pad * 2
const canvas = sharp({
  create: { width: totalW, height: H, channels: 4, background: { r: 245, g: 245, b: 248, alpha: 1 } },
})
const comps = []
let x = pad
for (const t of tiles) {
  comps.push({ input: t.buf, left: x, top: pad + (CELL_H - t.h) })
  x += t.w + pad
}
await canvas.composite(comps).png().toFile(outPath)

const b = edges[0]
console.log('帧            左边缘(Δ)   右边缘(Δ)')
for (const e of edges) {
  console.log(
    `${e.name.padEnd(14)}${String(e.left).padStart(6)}(${String(e.left - b.left).padStart(4)})` +
      `${String(e.right).padStart(8)}(${String(e.right - b.right).padStart(4)})`,
  )
}
console.log(`\n对照图 → ${outPath}`)
