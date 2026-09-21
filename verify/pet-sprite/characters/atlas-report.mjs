#!/usr/bin/env node
/**
 * atlas-report.mjs — 量一量装好的宠物：每帧占多大、动作到底动没动
 *
 * 这两件事都是用户反馈里说不清但能量清的：
 *   - 「图片大小不一样」→ 每帧内容包围盒的尺寸
 *   - 「帧不够连续、没有关键帧」→ 相邻帧的变化像素数 ÷ 角色面积
 *
 * 用法：node atlas-report.mjs <模型目录名>
 */

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const REPO = path.resolve(import.meta.dirname, '../../..')
const dir = process.argv[2]
if (!dir) throw new Error('用法：node atlas-report.mjs <模型目录名>')
const base = path.join(REPO, 'apps/windows/resources/pet-models', dir)

const index = JSON.parse(fs.readFileSync(path.join(base, 'atlas.json'), 'utf-8'))
const { data, info } = await sharp(path.join(base, 'atlas.png'))
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })
const W = info.width

function frame(name) {
  const f = index.frames[name].frame
  const buf = Buffer.alloc(f.w * f.h * 4)
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = ((f.y + y) * W + f.x + x) * 4
      const o = (y * f.w + x) * 4
      buf[o] = data[i]
      buf[o + 1] = data[i + 1]
      buf[o + 2] = data[i + 2]
      buf[o + 3] = data[i + 3]
    }
  }
  let minX = 1e9
  let maxX = -1
  let minY = 1e9
  let maxY = -1
  let n = 0
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      if (buf[(y * f.w + x) * 4 + 3] <= 16) continue
      n++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { name, buf, w: f.w, h: f.h, n, bbox: n === 0 ? null : { minX, maxX, minY, maxY } }
}

/** 两帧之间「变了」的像素数（任一边不透明的像素才参与比较） */
function diff(a, b) {
  let c = 0
  for (let i = 0; i < a.buf.length; i += 4) {
    if (a.buf[i + 3] <= 16 && b.buf[i + 3] <= 16) continue
    const d = Math.max(
      Math.abs(a.buf[i] - b.buf[i]),
      Math.abs(a.buf[i + 1] - b.buf[i + 1]),
      Math.abs(a.buf[i + 2] - b.buf[i + 2]),
      Math.abs(a.buf[i + 3] - b.buf[i + 3]),
    )
    if (d > 32) c++
  }
  return c
}

console.log(`${dir}：图集 ${info.width}×${info.height}，${Object.keys(index.frames).length} 帧\n`)

const groups = { Idle: [], Wave: null }
for (const name of Object.keys(index.frames)) {
  const f = frame(name)
  console.log(
    `  ${name.padEnd(16)} ${f.bbox ? `${f.bbox.maxX - f.bbox.minX + 1}×${f.bbox.maxY - f.bbox.minY + 1}`.padEnd(10) : '（空）'.padEnd(9)}` +
      ` 内容 ${String(f.n).padStart(6)}px` +
      (f.bbox ? `  底边 y=${f.bbox.maxY}` : ''),
  )
  if (/body_/.test(name)) groups.Idle.push(f)
  if (/_wave_/.test(name)) (groups.Wave ??= []).push(f)
}

for (const [label, list] of Object.entries(groups)) {
  if (!list || list.length < 2) continue
  const adj = list.slice(1).map((f, i) => diff(list[i], f))
  const loop = diff(list[list.length - 1], list[0])
  const area = Math.max(...list.map((f) => f.n))
  console.log(
    `\n${label} 相邻帧变化: ${adj.join(', ')}  | 首尾: ${loop}` +
      `\n  角色面积约 ${area}px ⇒ 相邻帧有 ${adj.map((d) => ((d / area) * 100).toFixed(0) + '%').join(' / ')} 的像素在变`,
  )
}
