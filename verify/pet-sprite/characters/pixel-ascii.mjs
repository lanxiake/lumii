#!/usr/bin/env node
/**
 * pixel-ascii.mjs — 把任意一张图降采样成字符画
 *
 * ## 为什么需要（而不是"打开看看"）
 *
 * 本机 Read 工具读不了图（png/jpg 都报 Unsupported Image，转码也没用——见记忆
 * 「Lumii 实测入口与 dev 重载」）。所有"这个形状对不对"的判断都得落到字符上。
 * `sheet-ascii.mjs` 是给 shimeji 表写的（固定 128 格、按行取），单图用不了。
 *
 * ## 怎么读这幅画
 *
 * 先取**内容包围盒**再降采样——角色通常只占画面三分之一，画满画布等于浪费分辨率。
 * 每个字符格取该块内所有像素的**平均亮度**，映射到 ` .:-=+*#%@`（暗→亮）。
 * 完全透明的块打空格。所以：
 *
 *   · 空格的边界 = 抠底抠出来的轮廓
 *   · 字符的疏密 = 明暗，粗描边会显成一条深色边
 *
 * `--alpha` 换一种画法：忽略亮度，只按**不透明像素占比**打字符。判断
 * "这 4 帧的形状是不是真的在变"用这个，因为它不受配色影响。
 *
 * `--box` 只打印包围盒不画图，用来快速比对两张图的取景差多少。
 *
 * 用法：
 *   node pixel-ascii.mjs <图> [宽 默认 72] [--alpha] [--box]
 */
import { createRequire } from 'node:module'
const require = createRequire('C:/myself/projects/my/open-source/lumii/package.json')
const sharp = require('sharp')

const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a))
const widthArg = argv.find((a) => /^\d+$/.test(a))
const useAlpha = argv.includes('--alpha')
const boxOnly = argv.includes('--box')
if (!file) throw new Error('用法：node pixel-ascii.mjs <图> [宽] [--alpha] [--box]')

const CW = Number(widthArg ?? 72)
const ALPHA_MIN = 8

const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const { width: W, height: H, channels: C } = info

// 内容包围盒：alpha 超过阈值的像素范围
let x0 = W
let x1 = -1
let y0 = H
let y1 = -1
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * C + 3] <= ALPHA_MIN) continue
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
}
if (x1 < 0) {
  console.log(`${file}: 整张全透明`)
  process.exit(0)
}
const bw = x1 - x0 + 1
const bh = y1 - y0 + 1
console.log(`${file}  ${W}×${H}  包围盒 ${bw}×${bh} @ (${x0},${y0})  占比 ${((100 * bw * bh) / (W * H)).toFixed(1)}%`)
if (boxOnly) process.exit(0)

// 终端字符高约为宽的两倍，纵向压一半补偿
const CH = Math.max(1, Math.round((CW * bh) / bw / 2))
const ramp = ' .:-=+*#%@'
const stepX = bw / CW
const stepY = bh / CH

const lines = []
for (let gy = 0; gy < CH; gy++) {
  let line = ''
  for (let gx = 0; gx < CW; gx++) {
    let alphaSum = 0
    let lumSum = 0
    let total = 0
    const sx = Math.floor(x0 + gx * stepX)
    const ex = Math.max(sx + 1, Math.floor(x0 + (gx + 1) * stepX))
    const sy = Math.floor(y0 + gy * stepY)
    const ey = Math.max(sy + 1, Math.floor(y0 + (gy + 1) * stepY))
    for (let y = sy; y < ey && y < H; y++) {
      for (let x = sx; x < ex && x < W; x++) {
        const i = (y * W + x) * C
        total++
        if (data[i + 3] > ALPHA_MIN) {
          alphaSum++
          lumSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
        }
      }
    }
    if (total === 0) {
      line += ' '
      continue
    }
    if (useAlpha) {
      const v = alphaSum / total
      line += v < 0.08 ? ' ' : ramp[Math.min(9, 1 + Math.floor(v * 9))]
    } else if (alphaSum / total < 0.35) {
      // 块内多半是透明 → 当轮廓外的空格，别让零星残留把形状糊掉
      line += ' '
    } else {
      const lum = lumSum / alphaSum / 255
      line += ramp[Math.min(9, Math.floor(lum * 10))]
    }
  }
  lines.push(line)
}
console.log(lines.join('\n'))
