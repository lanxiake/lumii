/**
 * 生成 Lumii 应用图标（圆形 icon.png / icon.ico）
 * 源图：assets/logo.png
 * 运行: pnpm exec tsx scripts/generate-icon.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const OUT_DIR = path.resolve(__dirname, '../assets')
const LOGO_SRC = path.join(OUT_DIR, 'logo.png')

/**
 * 将多尺寸 PNG 打包为简易 ICO
 */
function pngsToIco(pngBuffers: Buffer[]): Buffer {
  const count = pngBuffers.length
  const headerSize = 6 + count * 16
  let offset = headerSize
  const entries: Array<{ width: number; height: number; size: number; offset: number; data: Buffer }> = []

  for (const data of pngBuffers) {
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
  buf.writeUInt16LE(0, 0)
  buf.writeUInt16LE(1, 2)
  buf.writeUInt16LE(count, 4)

  let entryAt = 6
  for (const e of entries) {
    buf.writeUInt8(e.width, entryAt)
    buf.writeUInt8(e.height, entryAt + 1)
    buf.writeUInt8(0, entryAt + 2)
    buf.writeUInt8(0, entryAt + 3)
    buf.writeUInt16LE(1, entryAt + 4)
    buf.writeUInt16LE(32, entryAt + 6)
    buf.writeUInt32LE(e.size, entryAt + 8)
    buf.writeUInt32LE(e.offset, entryAt + 12)
    entryAt += 16
  }

  for (const e of entries) {
    e.data.copy(buf, e.offset)
  }
  return buf
}

/** 圆形遮罩 SVG */
function circleMaskSvg(size: number): Buffer {
  const r = size / 2
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/>` +
      `</svg>`,
  )
}

/** 将 logo 裁成圆形 PNG */
async function circularLogo(size: number): Promise<Buffer> {
  return sharp(LOGO_SRC)
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .ensureAlpha()
    .composite([{ input: circleMaskSvg(size), blend: 'dest-in' }])
    .png()
    .toBuffer()
}

/**
 * 主入口：圆形 icon.png / icon.ico / tray-icon.png
 */
async function main(): Promise<void> {
  if (!fs.existsSync(LOGO_SRC)) {
    throw new Error(`缺少产品 Logo：${LOGO_SRC}`)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), await circularLogo(256))

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = await Promise.all(sizes.map((s) => circularLogo(s)))
  const icoTmp = path.join(OUT_DIR, 'icon.ico.tmp')
  const icoOut = path.join(OUT_DIR, 'icon.ico')
  fs.writeFileSync(icoTmp, pngsToIco(pngs))
  try {
    fs.renameSync(icoTmp, icoOut)
  } catch {
    fs.copyFileSync(icoTmp, icoOut)
    fs.unlinkSync(icoTmp)
  }

  fs.writeFileSync(path.join(OUT_DIR, 'tray-icon.png'), await circularLogo(32))
  console.log('[generate-icon] wrote circular icon.png, icon.ico, tray-icon.png from logo.png')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
