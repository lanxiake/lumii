/**
 * image-resizer.ts — 图片缩放压缩 + 格式嗅探工具
 *
 * 职责：
 * 1. 格式嗅探：读取文件头魔数，准确识别 MIME 类型（取代纯扩展名映射）
 * 2. 尺寸裁剪：长边 > maxDimension 时等比缩放
 * 3. 大小压缩：字节数 > maxBytes 时逐步降质，直到满足约束
 * 4. 返回处理后的 Buffer + 最终 MIME 类型
 *
 * 依赖：sharp（已在 apps/windows/package.json 中声明）
 */

import sharp from 'sharp'
import { agentRuntimeLog as log } from './bridge-utils'

// ---------- 公共常量 ----------

/** 单张图片传给 LLM 的最大字节数（base64 前），超出则自动压缩 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5 MB

/** 图片长边最大像素，超出则等比缩放 */
export const MAX_DIMENSION = 2048

// ---------- 格式嗅探 ----------

/** 从 Buffer 头部魔数推断 MIME 类型，识别不到返回 null */
export function sniffMimeType(buf: Buffer): string | null {
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  // WEBP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  // TIFF: 49 49 2A 00 or 4D 4D 00 2A
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[3] === 0x2a)) return 'image/tiff'
  // AVIF / HEIC: ftyp box at offset 4
  if (buf.length >= 12) {
    const ftyp = buf.slice(4, 8).toString('ascii')
    if (ftyp === 'ftyp') {
      const brand = buf.slice(8, 12).toString('ascii')
      if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif'
      if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic'
    }
  }
  // ICO: 00 00 01 00
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon'
  return null
}

/** 从扩展名推断 MIME 类型（fallback，精度低） */
export function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase().replace(/^\./, '')) {
    case 'png': return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'svg': return 'image/svg+xml'
    case 'tiff': case 'tif': return 'image/tiff'
    case 'avif': return 'image/avif'
    case 'heic': case 'heif': return 'image/heic'
    default: return 'image/png'
  }
}

// ---------- 主函数 ----------

export interface ResizeResult {
  buffer: Buffer
  mimeType: string
  /** 是否经过缩放或压缩处理（false = 原图直接返回） */
  wasResized: boolean
  originalBytes: number
  finalBytes: number
}

/**
 * 对图片 Buffer 做格式嗅探 + 尺寸/大小约束处理。
 *
 * - SVG / GIF 等不经 sharp 处理的格式直接透传（LLM 通常不支持）
 * - HEIC/AVIF 转为 JPEG 输出（提高兼容性）
 * - 其他格式保持原格式，仅在超限时才压缩
 *
 * @param buf        原始图片字节
 * @param hint       扩展名提示（用于嗅探失败时 fallback），如 '.jpg'
 * @param maxDimension 长边最大像素，默认 MAX_DIMENSION
 * @param maxBytes   最大字节数，默认 MAX_IMAGE_BYTES
 */
export async function resizeImageIfNeeded(
  buf: Buffer,
  hint = '',
  maxDimension = MAX_DIMENSION,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<ResizeResult> {
  const originalBytes = buf.byteLength

  // 1. 格式嗅探
  const sniffed = sniffMimeType(buf)
  const mimeType = sniffed ?? mimeFromExt(hint)
  if (!sniffed) {
    log.warn(`[resizeImageIfNeeded] 魔数嗅探失败，使用扩展名 fallback: hint="${hint}" → ${mimeType}`)
  }

  // 2. 不支持 sharp 处理的格式直接透传
  const skipFormats = ['image/svg+xml', 'image/x-icon']
  if (skipFormats.includes(mimeType)) {
    log.info(`[resizeImageIfNeeded] 跳过 sharp 处理（格式=${mimeType}），原图透传`)
    return { buffer: buf, mimeType, wasResized: false, originalBytes, finalBytes: originalBytes }
  }

  // 3. 决定输出格式（HEIC/AVIF 转 JPEG）
  const needsConvert = mimeType === 'image/heic' || mimeType === 'image/avif' || mimeType === 'image/tiff'
  const outputMime = needsConvert ? 'image/jpeg' : mimeType

  // 4. 读取元数据
  let meta: sharp.Metadata
  try {
    meta = await sharp(buf).metadata()
  } catch (err) {
    log.warn(`[resizeImageIfNeeded] sharp.metadata 失败，原图透传: ${err instanceof Error ? err.message : String(err)}`)
    return { buffer: buf, mimeType, wasResized: false, originalBytes, finalBytes: originalBytes }
  }

  const { width = 0, height = 0 } = meta
  const longEdge = Math.max(width, height)

  // 5. 判断是否需要处理
  const needsScale = longEdge > maxDimension
  const needsCompress = originalBytes > maxBytes || needsConvert

  if (!needsScale && !needsCompress) {
    log.info(`[resizeImageIfNeeded] 无需处理: ${width}x${height}, ${(originalBytes / 1024).toFixed(0)}KB, mime=${mimeType}`)
    return { buffer: buf, mimeType, wasResized: false, originalBytes, finalBytes: originalBytes }
  }

  // 6. 执行缩放 + 压缩
  log.info(
    `[resizeImageIfNeeded] 开始处理: ${width}x${height} ${(originalBytes / 1024 / 1024).toFixed(2)}MB` +
    ` → maxDim=${maxDimension} maxBytes=${(maxBytes / 1024 / 1024).toFixed(1)}MB` +
    ` outputMime=${outputMime}`,
  )

  let pipeline = sharp(buf)

  // 等比缩放
  if (needsScale) {
    pipeline = pipeline.resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
    log.info(`[resizeImageIfNeeded] 等比缩放: 长边 ${longEdge} → ${maxDimension}`)
  }

  // 按格式输出，先用较高质量
  let quality = outputMime === 'image/png' ? undefined : 85
  let result = await toBuffer(pipeline, outputMime, quality)

  // 7. 如果仍超 maxBytes，逐步降质
  if (result.byteLength > maxBytes && outputMime !== 'image/png') {
    const qualities = [75, 65, 55, 45]
    for (const q of qualities) {
      if (result.byteLength <= maxBytes) break
      log.info(`[resizeImageIfNeeded] 仍超限 ${(result.byteLength / 1024).toFixed(0)}KB，降质到 q=${q}`)
      result = await toBuffer(sharp(result), outputMime, q)
    }
  }

  // PNG 超限时转 JPEG 压缩
  if (result.byteLength > maxBytes && outputMime === 'image/png') {
    log.info(`[resizeImageIfNeeded] PNG 超限，转 JPEG 压缩`)
    result = await toBuffer(sharp(result), 'image/jpeg', 80)
    if (result.byteLength > maxBytes) {
      for (const q of [70, 60, 50]) {
        if (result.byteLength <= maxBytes) break
        result = await toBuffer(sharp(result), 'image/jpeg', q)
      }
    }
  }

  const finalMime = outputMime
  log.info(
    `[resizeImageIfNeeded] 完成: ${(originalBytes / 1024 / 1024).toFixed(2)}MB → ${(result.byteLength / 1024 / 1024).toFixed(2)}MB` +
    ` (${((1 - result.byteLength / originalBytes) * 100).toFixed(0)}% 缩减), mime=${finalMime}`,
  )

  return {
    buffer: result,
    mimeType: finalMime,
    wasResized: true,
    originalBytes,
    finalBytes: result.byteLength,
  }
}

// ---------- 内部帮助 ----------

async function toBuffer(pipeline: sharp.Sharp, mime: string, quality?: number): Promise<Buffer> {
  switch (mime) {
    case 'image/jpeg':
      return pipeline.jpeg({ quality: quality ?? 85, mozjpeg: true }).toBuffer()
    case 'image/webp':
      return pipeline.webp({ quality: quality ?? 85 }).toBuffer()
    case 'image/png':
      return pipeline.png({ compressionLevel: 9 }).toBuffer()
    default:
      return pipeline.jpeg({ quality: quality ?? 85, mozjpeg: true }).toBuffer()
  }
}
