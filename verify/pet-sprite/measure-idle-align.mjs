#!/usr/bin/env node
/**
 * measure-idle-align.mjs — 待机帧"整体平移"占了多少，对齐后还剩多少动画
 *
 * ## 为什么必须先量这个再决定修法
 *
 * 已量出：8 张待机图里，**头带/中带/脚带的重心同向同幅移动 ±5 素材px**
 * （`measure-sheet-drift.mjs`），是整只猫在帧间左右平移，不是部件在动。
 *
 * 但"对齐掉这 5px"有个前提必须先验证：**如果 8 帧之间只有这个平移**，
 * 那么对齐 = 把动画彻底冻住。而用户明确说过「待机有自己的动画」——
 * 那对齐就成了把功能删掉，而不是修 bug。
 *
 * 所以要分开量两件事：
 *   · `dx`      —— 每帧相对参考帧的整体水平位移（互相关求峰值）
 *   · `残留`    —— 对齐前后，逐列质量分布的差异（L1）。**这个数才回答"还剩多少动画"**
 *
 * 判据：对齐后残留仍显著大于 0 ⇒ 动画是"形变"（对齐安全，只去掉平移）；
 *       对齐后残留趋近 0 ⇒ 动画就是那段平移本身（对齐要慎重，等于冻住）。
 *
 * 用法：node measure-idle-align.mjs <图集png> <图集json> [前缀]
 */
import sharp from 'sharp'
import { readFileSync } from 'node:fs'

const [pngPath, jsonPath, prefix = 'cat_body_'] = process.argv.slice(2)
const idx = JSON.parse(readFileSync(jsonPath, 'utf8'))
const names = Object.keys(idx.frames).filter((n) => n.startsWith(prefix)).sort()

const { width } = await sharp(pngPath).metadata()
const raw = await sharp(pngPath).ensureAlpha().raw().toBuffer()
const F = idx.frames[names[0]].frame
const W = F.w
const H = F.h

/** 每帧的逐列质量分布（长度 W） */
function columnProfile(name) {
  const f = idx.frames[name].frame
  const prof = new Float64Array(W)
  for (let y = f.y; y < f.y + f.h; y++) {
    for (let x = f.x; x < f.x + f.w; x++) {
      const a = raw[(y * width + x) * 4 + 3]
      if (a > 16) prof[x - f.x] += a / 255
    }
  }
  return prof
}

/** 把 prof 平移 dx 后与 ref 的 L1 距离（越小越像） */
function l1(ref, prof, dx) {
  let s = 0
  for (let x = 0; x < W; x++) {
    const sx = x - dx
    const v = sx >= 0 && sx < W ? prof[sx] : 0
    s += Math.abs(ref[x] - v)
  }
  return s
}

/**
 * 亚像素位移：整数部分取 L1 最小处，再用两侧的 L1 做**抛物线插值**取小数部分。
 *
 * 只取整数的话，±0.5px 的量化误差会直接变成"对齐后仍有残留"的假象——
 * 而这个脚本的全部意义就是判断"残留还剩多少"，不能自己制造残留。
 */
function bestShift(ref, prof, range = 12) {
  let best = 0
  let bestV = Infinity
  for (let dx = -range; dx <= range; dx++) {
    const v = l1(ref, prof, dx)
    if (v < bestV) {
      bestV = v
      best = dx
    }
  }
  const vm = l1(ref, prof, best - 1)
  const v0 = bestV
  const vp = l1(ref, prof, best + 1)
  const denom = vm - 2 * v0 + vp
  const frac = denom !== 0 ? 0.5 * (vm - vp) / denom : 0
  return { dx: best + Math.max(-1, Math.min(1, frac)), l1: v0 }
}

const ref = columnProfile(names[0])
console.log(`参考帧 ${names[0]}，${names.length} 帧，格 ${W}×${H}\n`)
console.log('帧                最佳位移dx     残留L1')
const shifts = []
for (const nm of names) {
  const p = columnProfile(nm)
  const { dx, l1: after } = bestShift(ref, p)
  shifts.push(dx)
  console.log(
    `${nm.padEnd(16)}${dx.toFixed(2).padStart(10)}${after.toFixed(0).padStart(12)}`,
  )
}

const before = names.map((nm) => l1(ref, columnProfile(nm), 0))
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
const beforeAvg = mean(before.slice(1))
const afterAvg = mean(shifts.slice(1).map((dx, i) => l1(ref, columnProfile(names[i + 1]), Math.round(dx))))
const span = Math.max(...shifts) - Math.min(...shifts)

console.log(`\n整体位移极差 ${span.toFixed(1)} 素材px（×0.2438 ≈ ${(span * 0.2438).toFixed(1)} 屏幕px）`)
console.log(`对齐前逐列差异均值 ${beforeAvg.toFixed(0)}，对齐后 ${afterAvg.toFixed(0)}` +
  `（去掉 ${(100 * (1 - afterAvg / beforeAvg)).toFixed(0)}%）`)
console.log(
  afterAvg / beforeAvg > 0.35
    ? '\n✅ 对齐后仍留有动画（形变为主）：对齐是安全的修法'
    : '\n⚠️ 对齐后几乎没有残留 —— 这段动画主要就是整体平移，对齐等于冻住它',
)
