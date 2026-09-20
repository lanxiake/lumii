/**
 * 图像检查（基于 sharp）。
 *
 * 只做「看一眼就能回答」的事——真正的像素处理在 cutout.ts。
 * 这里存在的理由是安装校验需要回答一个问题：**这张图集抠过底了吗？**
 * 判据是「有没有真正透明的像素」，不是「有没有 alpha 通道」——
 * AI 直出的 RGBA 图常常 alpha 全 255，光看通道会误判为已抠底。
 */

import sharp from 'sharp'

export interface AlphaInfo {
  width: number
  height: number
  /** 是否带 alpha 通道 */
  hasAlphaChannel: boolean
  /** alpha 通道最小值（0–255）；无 alpha 通道时为 255 */
  minAlpha: number
  /** 是否存在真正透明的像素（minAlpha < 阈值） */
  hasTransparency: boolean
}

/** 判定「透明」的 alpha 上限：留一点余量，容忍边缘的极低 alpha 残留 */
const TRANSPARENT_THRESHOLD = 8

/**
 * 检查图片的透明度情况。
 *
 * `minAlpha` 取的是 alpha 通道的最小值，因此对「整图 alpha 全 255」的
 * 伪 RGBA 会如实报告 255——这正是安装校验想知道的。
 */
export async function inspectAlpha(filePath: string): Promise<AlphaInfo> {
  const image = sharp(filePath, { failOn: 'none' })
  const meta = await image.metadata()
  const stats = await image.stats()
  const channels = stats.channels
  const hasAlphaChannel = channels.length >= 4 || meta.hasAlpha === true
  const alpha = hasAlphaChannel ? channels[3] : undefined
  const minAlpha = alpha ? alpha.min : 255
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    hasAlphaChannel,
    minAlpha,
    hasTransparency: minAlpha < TRANSPARENT_THRESHOLD,
  }
}

/** 读取图片为不透明 RGBA 像素（忽略原 alpha，抠底算法要的是原始合成结果） */
export async function readRgba(
  filePath: string,
): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(filePath, { failOn: 'none' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** 把 RGBA 像素写成 PNG */
export async function writeRgbaPng(
  filePath: string,
  data: Buffer,
  width: number,
  height: number,
): Promise<void> {
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(filePath)
}
