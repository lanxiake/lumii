/**
 * SoM（Set-of-Marks）编号标注：在截图 JPEG 上为每个 ref 绘制半透明数字徽章。
 */

import sharp from 'sharp'
import type { AppUiRef } from './types'

/** 徽章高度（像素） */
export const BADGE_HEIGHT = 20

/** 徽章最小宽度（像素） */
export const BADGE_MIN_WIDTH = 20

/** 徽章水平内边距（像素） */
export const BADGE_PADDING_X = 4

/** 徽章文字字号（像素） */
export const BADGE_FONT_SIZE = 12

/** 半透明背景色 */
export const BADGE_BG_COLOR = 'rgba(220, 38, 38, 0.75)'

/** 徽章文字颜色 */
export const BADGE_TEXT_COLOR = '#ffffff'

/** 单个编号徽章的几何与标签（供单测与 composite 共用） */
export interface AnnotateOverlay {
  ref: string
  label: string
  left: number
  top: number
  width: number
  height: number
}

/**
 * 从 ref 编号（如 e1）提取 SoM 显示数字。
 */
function refLabel(ref: string): string {
  const match = /^e(\d+)$/.exec(ref)
  return match ? match[1]! : ref
}

/**
 * 估算标签文字宽度（避免引入 canvas 度量依赖）。
 */
function estimateLabelWidth(label: string): number {
  return label.length * Math.ceil(BADGE_FONT_SIZE * 0.65) + BADGE_PADDING_X * 2
}

/**
 * 计算每个 ref 左上角编号徽章的几何参数。
 */
export function buildAnnotateOverlays(refs: AppUiRef[]): AnnotateOverlay[] {
  return refs.map((r) => {
    const label = refLabel(r.ref)
    const width = Math.max(BADGE_MIN_WIDTH, estimateLabelWidth(label))
    return {
      ref: r.ref,
      label,
      left: Math.round(r.x),
      top: Math.round(r.y),
      width,
      height: BADGE_HEIGHT,
    }
  })
}

/**
 * 生成单个徽章的 SVG overlay（供 sharp composite 使用）。
 */
function buildBadgeSvg(overlay: AnnotateOverlay): string {
  const { label, width, height } = overlay
  const textY = height / 2 + BADGE_FONT_SIZE * 0.35
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" rx="3" ry="3" fill="${BADGE_BG_COLOR}"/>`,
    `<text x="${width / 2}" y="${textY}" font-family="Arial,sans-serif"`,
    ` font-size="${BADGE_FONT_SIZE}" fill="${BADGE_TEXT_COLOR}" text-anchor="middle">${label}</text>`,
    '</svg>',
  ].join('')
}

/**
 * 在 JPEG buffer 上为每个 ref 绘制 SoM 编号徽章，返回新 buffer。
 */
export async function annotateSnapshot(imageBuffer: Buffer, refs: AppUiRef[]): Promise<Buffer> {
  if (refs.length === 0) {
    return imageBuffer
  }

  const overlays = buildAnnotateOverlays(refs)
  const composites = overlays.map((overlay) => ({
    input: Buffer.from(buildBadgeSvg(overlay)),
    top: Math.max(0, overlay.top),
    left: Math.max(0, overlay.left),
  }))

  return sharp(imageBuffer).composite(composites).jpeg({ quality: 90 }).toBuffer()
}
