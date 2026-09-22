#!/usr/bin/env node
/**
 * pixel-measure.mjs — 量「这张图有多像素画」
 *
 * ## 为什么需要它（而不是"看一眼"）
 *
 * 量化到底管不管用，肉眼看并排图**会骗人**：缩放方式、显示器插值、肉眼对
 * 色阶的记忆，任一项都能让"其实只是模糊了一点"看起来像"变成了像素画"。
 * 而且这个仓库的验证链一直读不了图（Read 工具报 Unsupported Image），
 * 判据只能落在数字上。
 *
 * ## 判据是什么
 *
 * 像素画的定义性特征是**相邻像素要么完全相同、要么突变**，不存在中间过渡。
 * 所以对每个水平/垂直相邻的不透明像素对量 RGB 欧氏距离 `d`：
 *
 *   · `d == 0`      —— 同一色块内部。像素画里应该占绝对多数
 *   · `0 < d <= 12` —— **软过渡**（抗锯齿、渐变、噪点）。像素画里应该趋近 0
 *   · `d > 12`      —— 色块边界
 *
 * 三个数一起看才有意义：只看"颜色数从 33364 掉到 24"会漏掉一种失败——
 * 量化把渐变切成了条带（banding），颜色数是少了，软过渡反而变多。
 *
 * `distinct` 是**颜色种类**，`flat` 是 `d==0` 的占比，`soft` 是软过渡占比。
 *
 * 用法：node pixel-measure.mjs <图...>
 */
import sharp from 'sharp'

const SOFT = 12 // 欧氏距离阈值：再小算"肉眼分不出的过渡"，那是软边不是色块界

async function measure(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels: ch } = info

  const colors = new Set()
  let opaque = 0
  let flat = 0
  let soft = 0
  let edge = 0
  let sum = 0
  let pairs = 0

  const at = (x, y) => (y * w + x) * ch

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = at(x, y)
      if (data[i + 3] === 0) continue
      opaque++
      colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])

      // 只看右邻与下邻：每对相邻像素恰好被数一次
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= w || ny >= h) continue
        const j = at(nx, ny)
        if (data[j + 3] === 0) continue // 跨到透明区不算——那是轮廓，不是色块界
        const d = Math.hypot(data[i] - data[j], data[i + 1] - data[j + 1], data[i + 2] - data[j + 2])
        pairs++
        sum += d
        if (d === 0) flat++
        else if (d <= SOFT) soft++
        else edge++
      }
    }
  }

  const pct = (n) => (pairs === 0 ? 0 : +((100 * n) / pairs).toFixed(2))
  return {
    file: file.split(/[\\/]/).pop(),
    size: `${w}×${h}`,
    opaque,
    distinct: colors.size,
    'flat%': pct(flat),
    'soft%': pct(soft),
    'edge%': pct(edge),
    'avgΔ': pairs === 0 ? 0 : +(sum / pairs).toFixed(2),
  }
}

const files = process.argv.slice(2)
if (files.length === 0) throw new Error('用法：node pixel-measure.mjs <图...>')
const rows = []
for (const f of files) rows.push(await measure(f))
console.table(rows)
