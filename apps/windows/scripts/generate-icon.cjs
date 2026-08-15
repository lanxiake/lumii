/**
 * 从 assets/icon.png 生成 Windows 应用图标。
 * 产出：icon.ico（多尺寸，写入 exe / 桌面 / 任务栏）、tray-icon.png
 * 运行: pnpm generate:icon（在 apps/windows 下）
 *
 * 注意：不覆盖 icon.png，它是产品指定的应用图标源图。
 */
const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')

const OUT_DIR = path.resolve(__dirname, '../assets')
const ICON_PNG = path.join(OUT_DIR, 'icon.png')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** 小尺寸用 BMP，Windows 资源管理器 / 任务栏更稳 */
const BMP_SIZES = new Set([16, 24, 32, 48])

/**
 * 把多帧图像打包成 ICO（PNG 或 32-bit BMP）。
 * @param {Array<{ width: number, height: number, data: Buffer }>} frames
 * @returns {Buffer}
 */
function imagesToIco(frames) {
  const count = frames.length
  const headerSize = 6 + count * 16
  let offset = headerSize
  const entries = frames.map((frame) => {
    const entry = {
      width: frame.width >= 256 ? 0 : frame.width,
      height: frame.height >= 256 ? 0 : frame.height,
      size: frame.data.length,
      offset,
      data: frame.data,
    }
    offset += frame.data.length
    return entry
  })

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

/**
 * 将 RGBA raw 像素转为 ICO 内嵌的 32-bit BMP（无 BITMAPFILEHEADER）。
 * @param {Buffer} rgba 自上而下 RGBA
 * @param {number} size
 * @returns {Buffer}
 */
function rgbaToBmp32Icon(rgba, size) {
  const headerSize = 40
  const xorSize = size * size * 4
  const andRowBytes = Math.ceil(size / 32) * 4
  const andSize = andRowBytes * size
  const buf = Buffer.alloc(headerSize + xorSize + andSize)

  buf.writeUInt32LE(40, 0)
  buf.writeInt32LE(size, 4)
  buf.writeInt32LE(size * 2, 8)
  buf.writeUInt16LE(1, 12)
  buf.writeUInt16LE(32, 14)
  buf.writeUInt32LE(0, 16)
  buf.writeUInt32LE(xorSize, 20)

  let dest = headerSize
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4
      buf[dest] = rgba[src + 2]
      buf[dest + 1] = rgba[src + 1]
      buf[dest + 2] = rgba[src]
      buf[dest + 3] = rgba[src + 3]
      dest += 4
    }
  }
  return buf
}

/**
 * 把 icon.png 缩放到指定边长。
 * @param {number} size
 */
async function resizeIcon(size) {
  return sharp(ICON_PNG)
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .ensureAlpha()
    .png()
    .toBuffer()
}

/**
 * 生成一帧 ICO 图像（小尺寸 BMP，大尺寸 PNG）。
 * @param {number} size
 */
async function buildIconFrame(size) {
  if (BMP_SIZES.has(size)) {
    const { data } = await sharp(ICON_PNG)
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return { width: size, height: size, data: rgbaToBmp32Icon(data, size) }
  }

  const png = await resizeIcon(size)
  return { width: size, height: size, data: png }
}

/**
 * 原子写入文件，避免被运行中的 Electron 锁住目标路径。
 * @param {string} dest
 * @param {Buffer} data
 */
function writeAtomic(dest, data) {
  const tmp = `${dest}.tmp`
  fs.writeFileSync(tmp, data)
  try {
    fs.renameSync(tmp, dest)
  } catch {
    fs.copyFileSync(tmp, dest)
    fs.unlinkSync(tmp)
  }
}

/**
 * 主入口：icon.png → icon.ico + tray-icon.png
 */
async function main() {
  if (!fs.existsSync(ICON_PNG)) {
    throw new Error(`缺少应用图标：${ICON_PNG}`)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })

  const frames = await Promise.all(ICO_SIZES.map((size) => buildIconFrame(size)))
  writeAtomic(path.join(OUT_DIR, 'icon.ico'), imagesToIco(frames))
  writeAtomic(path.join(OUT_DIR, 'tray-icon.png'), await resizeIcon(32))

  console.log('[generate-icon] wrote icon.ico, tray-icon.png from assets/icon.png')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
