#!/usr/bin/env node
/**
 * frame-report.mjs — 把一串视频帧摊成数字，回答「这批帧能不能用」
 *
 * ## 为什么需要它
 *
 * 本机**看不了图**：Read 工具对 png/jpg 一律回 `[Unsupported Image]`，
 * 走 MCP 的 get_image 也是同一句。所以「视频模型出的帧好不好」只能落到数字上。
 * 三个数各对应一种会让精灵图作废的故障：
 *
 *   · `bgΔ`  —— 背景相对首帧四角色的偏离。精灵图要抠底，背景一变
 *                （渐变、阴影、机位光变）就抠不干净，边缘留一圈残色。
 *   · `box`  —— 角色包围盒。机位一动、角色一缩放，抽出来的帧就**对不齐**，
 *                连起来播是一跳一跳的。比的是各帧包围盒与首帧的偏移。
 *   · `Δprev`—— 相邻帧差异占比。太小说明角色压根没动，抽帧做出来是张静止画；
 *                太大（半个画面都在变）说明模型在重画整个画面，不是在动肢体。
 *
 * ## 为什么用「偏离」而不是「相等」
 *
 * 视频模型即使老老实实守着纯色底，也会有编码噪声（同一块背景逐帧差 1~3/255）。
 * 所以判据是**偏离背景色超过阈值**，不是逐字节相等。
 *
 * 用法：
 *   node frame-report.mjs <帧目录> [--tol 40] [--stride 1] [--list 8]
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const argv = process.argv.slice(2)
const dir = argv[0]
if (!dir) {
  console.error('用法：node frame-report.mjs <帧目录> [--tol 40] [--list 8]')
  process.exit(1)
}
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : Number(argv[i + 1])
}
/** 相对背景色的容差：单通道差超过它才算「这是角色」 */
const TOL = opt('tol', 40)

const files = fs
  .readdirSync(dir)
  .filter((f) => /\.png$/i.test(f))
  .sort()
if (!files.length) throw new Error(`${dir} 里没有 png`)

const frames = []
for (const f of files) {
  const { data, info } = await sharp(path.join(dir, f)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  frames.push({ name: f, data, w: info.width, h: info.height })
}
const { w, h } = frames[0]
console.log(`# ${path.basename(dir)}  ${files.length} 帧  ${w}×${h}`)

/** 背景色 = 首帧四角各取一小块的中位色（四角一定在角色之外） */
function cornerSample(fr, cx, cy) {
  const px = []
  for (let y = cy; y < cy + 8; y++) {
    for (let x = cx; x < cx + 8; x++) {
      const p = (y * fr.w + x) * 4
      px.push([fr.data[p], fr.data[p + 1], fr.data[p + 2]])
    }
  }
  const med = (i) => px.map((c) => c[i]).sort((a, b) => a - b)[px.length >> 1]
  return [med(0), med(1), med(2)]
}
const c0 = cornerSample(frames[0], 0, 0)
const c1 = cornerSample(frames[0], w - 8, 0)
const c2 = cornerSample(frames[0], 0, h - 8)
const c3 = cornerSample(frames[0], w - 8, h - 8)
const bg = [0, 1, 2].map((i) => [c0, c1, c2, c3].map((c) => c[i]).sort((a, b) => a - b)[1] | 0)
console.log(`背景色（首帧四角中位）: rgb(${bg.join(',')})  四角: ${[c0, c1, c2, c3].map((c) => c.join('/')).join('  ')}`)

/** 逐帧：算「非背景」像素的包围盒、数量，以及与首帧背景的偏离 */
function analyze(fr) {
  let minX = w, minY = h, maxX = -1, maxY = -1, count = 0, bgBad = 0, bgSamples = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * fr.w + x) * 4
      const a = fr.data[p + 3]
      if (a < 128) continue
      const d = Math.max(
        Math.abs(fr.data[p] - bg[0]),
        Math.abs(fr.data[p + 1] - bg[1]),
        Math.abs(fr.data[p + 2] - bg[2]),
      )
      if (d > TOL) {
        count++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      // 背景健康度只看四条边——角色不在边上，那里的偏离只可能来自背景自身变化
      else if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) {
        bgSamples++
        if (d > 12) bgBad++
      }
    }
  }
  return { minX, minY, maxX, maxY, count, bgBadPct: bgSamples ? (100 * bgBad) / bgSamples : 0 }
}

const stats = frames.map(analyze)
const b0 = stats[0]
console.log(`\n${'帧'.padEnd(10)} ${'包围盒'.padEnd(22)} ${'相对首帧'.padEnd(10)} ${'面积'.padEnd(9)} ${'边带背景漂移'.padEnd(8)}`)
for (let i = 0; i < frames.length; i += opt('stride', 1)) {
  const s = stats[i]
  const box = `${s.minX},${s.minY} → ${s.maxX},${s.maxY}`
  const dbox = s.minX === w ? '空' : `${s.minX - b0.minX >= 0 ? '+' : ''}${s.minX - b0.minX},${s.minY - b0.minY >= 0 ? '+' : ''}${s.minY - b0.minY}`
  console.log(
    `${frames[i].name.padEnd(10)} ${box.padEnd(22)} ${dbox.padEnd(10)} ${String(s.count).padEnd(9)} ${s.bgBadPct.toFixed(1)}%`,
  )
}

/** 相邻帧差异：判「动作幅度」和「有没有整屏重画」 */
const diffs = []
for (let i = 1; i < frames.length; i++) {
  const a = frames[i - 1].data, b = frames[i].data
  let d = 0, n = 0
  for (let p = 0; p < a.length; p += 4) {
    n++
    if (Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]) > 30) d++
  }
  diffs.push((100 * d) / n)
}
const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length
const maxD = Math.max(...diffs), minD = Math.min(...diffs)
console.log(`\n相邻帧差异: 平均 ${avg.toFixed(2)}%  最小 ${minD.toFixed(2)}%  最大 ${maxD.toFixed(2)}%`)
console.log(`首末帧差异（循环闭合度）: ${(() => {
  const a = frames[0].data, b = frames[frames.length - 1].data
  let d = 0, n = 0
  for (let p = 0; p < a.length; p += 4) {
    n++
    if (Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]) > 30) d++
  }
  return ((100 * d) / n).toFixed(2)
})()}%`)

console.log(
  `差异最大的相邻对: ${diffs
    .map((d, i) => [d, i])
    .sort((a, b) => b[0] - a[0])
    .slice(0, 6)
    .map(([d, i]) => `f${i}→f${i + 1}(${d.toFixed(1)}%)`)
    .join(' ')}`,
)
