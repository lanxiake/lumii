#!/usr/bin/env node
/**
 * measure-sheet-drift.mjs — 量"素材帧之间角色有没有左右游移"
 *
 * 症状：待机时宠物看起来在左右摆动，但清单的 Idle 组里**没有任何 sway/bob**
 * （只有 breathe + blink），程序化那一层不背这个锅。
 * 那就只剩一个来源：**图集里每一帧的角色站位本身就不一样**——
 * 8 张待机图是逐张生成的，没有做水平对齐的话，轮廓重心逐帧左右游移，
 * 4fps 循环播出来就是"左右摆动"。
 *
 * 判据：逐帧算**不透明像素的水平重心**与包围盒，看极差（peak-to-peak）。
 * 极差 ≤ 2px 视为对齐（AI 生图 + 抠图后的正常抖动）；
 * 超过就是肉眼可见的摆，得在打包期做水平对齐。
 *
 * ## 判据只看**重心**，不看包围盒
 *
 * 这条是被实测教出来的：团子对齐前 **包围盒中心极差 1.0px**（看着像已经对齐好了），
 * 而**重心极差 9.2px**——整只猫在左右平移，只是耳朵/尾巴那两个极值点没动，
 * 把包围盒钉住了。**包围盒是极值统计，重心是质量统计**；摇晃的是后者。
 * 对齐之后两个数会互换（重心 0.8 / 包围盒 8.0），所以包围盒只能当诊断信息打出来，
 * 拿它当判据会在两个方向上各骗一次。
 *
 * 用法：node measure-sheet-drift.mjs <图集png> <图集json> [组名前缀]
 */
import sharp from 'sharp'
import { readFileSync } from 'node:fs'

const [pngPath, jsonPath, prefix = 'cat_body_'] = process.argv.slice(2)
if (!pngPath || !jsonPath) {
  console.error('用法: node measure-sheet-drift.mjs <图集png> <图集json> [组名前缀]')
  process.exit(2)
}

const idx = JSON.parse(readFileSync(jsonPath, 'utf8'))
const names = Object.keys(idx.frames).filter((n) => n.startsWith(prefix)).sort()
if (names.length === 0) {
  console.error(`图集里没有以 "${prefix}" 开头的条目`)
  process.exit(2)
}

const img = sharp(pngPath).ensureAlpha()
const { width, height } = await img.metadata()
const raw = await img.raw().toBuffer()

const rows = []
for (const name of names) {
  const f = idx.frames[name].frame
  let sumX = 0
  let count = 0
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (let y = f.y; y < f.y + f.h; y++) {
    for (let x = f.x; x < f.x + f.w; x++) {
      if (raw[(y * width + x) * 4 + 3] <= 16) continue
      sumX += x - f.x
      count++
      if (x - f.x < left) left = x - f.x
      if (x - f.x > right) right = x - f.x
      if (y - f.y < top) top = y - f.y
      if (y - f.y > bottom) bottom = y - f.y
    }
  }
  if (count === 0) {
    console.log(`${name}: 全透明（空帧）`)
    continue
  }
  rows.push({
    name,
    centroid: sumX / count,
    boxCenter: (left + right) / 2,
    w: right - left + 1,
    h: bottom - top + 1,
    bottom,
  })
}

const fmt = (v) => v.toFixed(1).padStart(7)
console.log(`图集 ${width}×${height}，条目 ${names.length} 个（前缀 "${prefix}"）\n`)
console.log('条目            重心X   包围盒中心X   宽   高   底边Y')
for (const r of rows) {
  console.log(
    `${r.name.padEnd(16)}${fmt(r.centroid)}${fmt(r.boxCenter)}${String(r.w).padStart(6)}${String(r.h).padStart(6)}${String(r.bottom).padStart(8)}`,
  )
}

const span = (key) => {
  const vs = rows.map((r) => r[key])
  return Math.max(...vs) - Math.min(...vs)
}
const cSpan = span('centroid')
const bSpan = span('boxCenter')
const hSpan = span('bottom')
console.log(
  `\n水平重心极差 ${cSpan.toFixed(1)}px，包围盒中心极差 ${bSpan.toFixed(1)}px，底边极差 ${hSpan}px`,
)
// 判据只看重心（见文件头）。包围盒极差一并打出来，是因为它对齐前后会反向变化，
// 单看它会在两个方向上各骗一次。
console.log(
  cSpan <= 2
    ? `✅ 帧间质量不游移（重心 ≤2px；包围盒 ${bSpan.toFixed(1)}px 是部件伸缩，不是平移）`
    : `❌ 整体在左右平移（重心极差 ${cSpan.toFixed(1)}px）——用 align-idle-frames.mjs 对齐`,
)
