#!/usr/bin/env node
/**
 * pixel-review.mjs — 把「AI 原图 → Pixelorama 技能产出」拼成一张并排对照图
 *
 * ## 为什么要有它
 *
 * 像素产出的**正确看法只有一种——最近邻放大**。用默认插值放大出来的图
 * 会把硬色块糊成渐变，看起来像"低质量照片"，于是"量化到底有没有用"这件事
 * 就看不出来了。**插值方式会直接改变结论。**
 *
 * 另一半是**并排**：单独看像素图只能说"嗯挺像像素画"，与原图并排才能回答
 * "AI 出的照片感被压掉了多少、描边还在不在"。所以第一张永远是原图。
 *
 * 透明底垫白：RGBA 的帧直接看是"缺了一块"，看不出形状。
 *
 * ## 放大倍率取整数
 *
 * 小像素图（49×64 这种）放大时**必须整数倍**，否则最近邻下有的像素占 6px、
 * 有的占 7px，边缘会一顿一顿的——那是我自己画出来的假象，不是产出的问题。
 * 图比格子大（657×851 这种"高分辨率像素图"）就没法整数倍了，退回插值缩小：
 * 色块够大，缩完仍然是色块。
 *
 * 用法：node pixel-review.mjs <输出.png> <原图> <产出图...> [--cell 320]
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const argv = process.argv.slice(2)
const ci = argv.indexOf('--cell')
const CELL = ci === -1 ? 320 : Number(argv[ci + 1])
const files = argv.slice(0, ci === -1 ? argv.length : ci).filter((a) => !a.startsWith('--'))
const [out, ...rest] = files
if (!out || rest.length < 2) {
  throw new Error('用法：node pixel-review.mjs <输出.png> <原图> <产出图...> [--cell 320]')
}

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 }

/** 垫白 → 缩放到能放进 CELL×CELL → 居中垫成正方形 */
async function tile(file, { nearest }) {
  const meta = await sharp(file).metadata()
  const k = Math.floor(CELL / Math.max(meta.width, meta.height))
  const flat = () => sharp(file).flatten({ background: WHITE })
  const buf =
    nearest && k >= 1
      ? await flat().resize({ width: meta.width * k, kernel: 'nearest' }).png().toBuffer()
      : await flat()
          .resize({ width: CELL, height: CELL, fit: 'inside', kernel: 'lanczos3' })
          .png()
          .toBuffer()
  const m = await sharp(buf).metadata()
  return {
    buf: await sharp({ create: { width: CELL, height: CELL, channels: 3, background: WHITE } })
      .composite([
        {
          input: buf,
          left: Math.round((CELL - m.width) / 2),
          top: Math.round((CELL - m.height) / 2),
        },
      ])
      .png()
      .toBuffer(),
    note: nearest && k >= 1 ? `最近邻 ${k}×` : '插值缩小',
  }
}

const tiles = []
for (let i = 0; i < rest.length; i++) {
  // 第一张是原图（未量化，连续色调），其余都是技能产出
  tiles.push({ file: rest[i], ...(await tile(rest[i], { nearest: i > 0 })) })
}

const W = CELL * tiles.length
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
await sharp({ create: { width: W, height: CELL, channels: 3, background: WHITE } })
  .composite(tiles.map((t, i) => ({ input: t.buf, left: CELL * i, top: 0 })))
  .png({ compressionLevel: 9 })
  .toFile(out)

console.log(`✓ ${out}  ${W}×${CELL}`)
tiles.forEach((t, i) =>
  console.log(`  第 ${i + 1} 格  ${path.basename(t.file).padEnd(22)} ${t.note}`),
)
