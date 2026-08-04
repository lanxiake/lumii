/**
 * 生成 Lumii 应用图标（icon.png / icon.ico）
 * 运行: pnpm exec tsx scripts/generate-icon.ts（在 apps/windows 下）
 */

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const OUT_DIR = path.resolve(__dirname, '../assets')

/** 生成 256×256 SVG 源图（光栖：渐变圆 + L） */
function buildSvg(size: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="12" y1="8" x2="52" y2="56" gradientUnits="userSpaceOnUse">
      <stop stop-color="#7DD3FC"/>
      <stop offset="0.45" stop-color="#38BDF8"/>
      <stop offset="1" stop-color="#2563EB"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="#0F172A"/>
  <circle cx="32" cy="32" r="22" fill="url(#g)"/>
  <path d="M22 38.5C22 30.5 27.2 24 34.5 24C40.2 24 44.5 27.8 45.5 33" stroke="white" stroke-width="3.2" stroke-linecap="round" fill="none" opacity="0.92"/>
  <path d="M26 20.5V43.5H40" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>
</svg>`
}

/**
 * 将多尺寸 PNG 打包为简易 ICO（含 ICONDIR + 各 PNG 图像）
 */
function pngsToIco(pngBuffers: Buffer[]): Buffer {
  const count = pngBuffers.length
  const headerSize = 6 + count * 16
  let offset = headerSize
  const entries: Array<{ width: number; height: number; size: number; offset: number; data: Buffer }> = []

  for (const data of pngBuffers) {
    // 从 IHDR 读宽高（大端）
    const width = data.readUInt32BE(16)
    const height = data.readUInt32BE(20)
    entries.push({
      width: width >= 256 ? 0 : width,
      height: height >= 256 ? 0 : height,
      size: data.length,
      offset,
      data,
    })
    offset += data.length
  }

  const buf = Buffer.alloc(offset)
  buf.writeUInt16LE(0, 0) // reserved
  buf.writeUInt16LE(1, 2) // type = icon
  buf.writeUInt16LE(count, 4)

  let entryAt = 6
  for (const e of entries) {
    buf.writeUInt8(e.width, entryAt)
    buf.writeUInt8(e.height, entryAt + 1)
    buf.writeUInt8(0, entryAt + 2) // color palette
    buf.writeUInt8(0, entryAt + 3)
    buf.writeUInt16LE(1, entryAt + 4) // planes
    buf.writeUInt16LE(32, entryAt + 6) // bit count
    buf.writeUInt32LE(e.size, entryAt + 8)
    buf.writeUInt32LE(e.offset, entryAt + 12)
    entryAt += 16
  }

  for (const e of entries) {
    e.data.copy(buf, e.offset)
  }
  return buf
}

/**
 * 主入口：写出 icon.png 与多尺寸 icon.ico
 */
async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const svg = Buffer.from(buildSvg(256))
  const png256 = await sharp(svg).png().toBuffer()
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png256)

  const sizes = [16, 32, 48, 64, 128, 256]
  const pngs = await Promise.all(
    sizes.map(async (s) => sharp(svg).resize(s, s).png().toBuffer()),
  )
  const ico = pngsToIco(pngs)
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico)
  console.log(`[generate-icon] wrote ${path.join(OUT_DIR, 'icon.png')} and icon.ico`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
