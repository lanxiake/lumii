#!/usr/bin/env node
/**
 * pixel-downsample.mjs — 众数降采样：把量化后的插画变成像素画
 *
 * ## 为什么不是最近邻、也不是面积平均
 *
 * 「AI 插画 → 低分辨率像素图」这一步，我先后试过两种缩放，都不对：
 *
 *   · **最近邻**只采样块里的**一个**像素。角色边缘那一圈全是抗锯齿过渡色，
 *     采到谁全看运气 → 边缘一帧一个样（实测缩到 64px 后 IoU 94.88%）。
 *   · **面积平均**把块内颜色混成一个**新颜色**，而新颜色不在调色板里，
 *     于是又得量化一遍；更糟的是它产生的半透明边缘像素会被
 *     `_apply_palette` 的 `if c.a < 0.5: continue` 整个跳过（实测 147 色 vs 16 色）。
 *
 * **众数**才是像素画的降采样方式：每个目标像素取块内**出现最多的那个颜色**。
 * 不产生新颜色、不受边缘过渡色干扰、结果仍严格落在原调色板内。
 * 面积平均问的是"这块平均什么颜色"，众数问的是"这块主要是什么颜色"——
 * 像素画要的是后者。
 *
 * ## 前提：输入**必须已经量化过**
 *
 * 没量化的图里每个像素颜色都不同，众数没有意义（全是 1 票）。
 * 先 `quantize`，再 `downsample`，顺序不能反。
 *
 * `--min-share` 是块内最低占比：低于它判为透明。默认 0.5——一块里过半是
 * 背景就整块透明，角色的细窄部位（腿、尾巴）也不会被背景吃掉。
 *
 * 用法：
 *   node pixel-downsample.mjs <已量化的 png> <out.png> --height 52 [--min-share 0.5]
 *   node pixel-downsample.mjs <已量化的 png> <out.png> --width 40
 */
import { createRequire } from 'node:module'
const require = createRequire('C:/myself/projects/my/open-source/lumii/package.json')
const sharp = require('sharp')

const argv = process.argv.slice(2)
const files = argv.filter((a) => !a.startsWith('--'))
const [src, out] = files
const val = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? dflt : Number(argv[i + 1])
}
const wantW = val('width', 0)
const wantH = val('height', 0)
const MIN_SHARE = val('min-share', 0.5)
if (!src || !out) throw new Error('用法：pixel-downsample.mjs <png> <out.png> --height N')

const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const { width: W, height: H, channels: C } = info

const cw = wantW || Math.max(1, Math.round((W * wantH) / H))
const ch = wantH || Math.max(1, Math.round((H * wantW) / W))
const bw = W / cw
const bh = H / ch

const buf = Buffer.alloc(cw * ch * 4, 0)
let opaque = 0
for (let ty = 0; ty < ch; ty++) {
  for (let tx = 0; tx < cw; tx++) {
    const x0 = Math.floor(tx * bw)
    const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * bw))
    const y0 = Math.floor(ty * bh)
    const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * bh))
    const hist = new Map()
    let total = 0
    let solid = 0
    for (let y = y0; y < y1 && y < H; y++) {
      for (let x = x0; x < x1 && x < W; x++) {
        const i = (y * W + x) * C
        total++
        if (data[i + 3] <= 8) continue
        solid++
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
        hist.set(key, (hist.get(key) ?? 0) + 1)
      }
    }
    if (total === 0 || solid / total < MIN_SHARE) continue
    // 众数；票数相同时取较暗的那个（描边比填充重要——丢了描边角色会散）
    let best = -1
    let bestN = -1
    for (const [key, n] of hist) {
      const lum = 0.299 * ((key >> 16) & 0xff) + 0.587 * ((key >> 8) & 0xff) + 0.114 * (key & 0xff)
      const bestLum =
        best < 0
          ? 1e9
          : 0.299 * ((best >> 16) & 0xff) + 0.587 * ((best >> 8) & 0xff) + 0.114 * (best & 0xff)
      if (n > bestN || (n === bestN && lum < bestLum)) {
        best = key
        bestN = n
      }
    }
    const i = (ty * cw + tx) * 4
    buf[i] = (best >> 16) & 0xff
    buf[i + 1] = (best >> 8) & 0xff
    buf[i + 2] = best & 0xff
    buf[i + 3] = 255
    opaque++
  }
}
await sharp(buf, { raw: { width: cw, height: ch, channels: 4 } }).png().toFile(out)
console.log(`✓ ${out}  ${cw}×${ch}（从 ${W}×${H}，每块 ${bw.toFixed(1)}×${bh.toFixed(1)}）`)
console.log(`  不透明 ${opaque}/${cw * ch} = ${((100 * opaque) / (cw * ch)).toFixed(1)}%`)
