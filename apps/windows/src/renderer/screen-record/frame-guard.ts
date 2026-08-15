/**
 * 画面守卫：录制输出尺寸计算 + 黑/白屏（空帧）检测
 *
 * 目标窗口被最小化或隐藏时，桌面捕获会持续产出纯黑/纯白帧。
 * 检测到空帧后由采集层冻结最后一帧，避免成片中出现整段黑屏/白屏。
 */

/** 输出分辨率上限（超出等比缩放，兼顾体积与清晰度） */
export const MAX_CAPTURE_WIDTH = 1920
export const MAX_CAPTURE_HEIGHT = 1080

/** 连续空帧超过该时长才判定为「画面丢失」并冻结 */
export const BLANK_HOLD_MS = 400

/**
 * 空帧判定阈值。
 * 最小化窗口的捕获帧并非严格纯色：边框、圆角、阴影残留会留下少量杂点，
 * 因此比例放宽到 97%，明暗容差也相应放大，避免漏判导致整段白屏写进成片。
 * 缩略采样（32x18）会把文字/图标平均成灰色，正常内容不会命中该阈值。
 */
const BLANK_PIXEL_RATIO = 0.97
const DARK_MAX = 12
const LIGHT_MIN = 243

/** 向下取偶（H.264/VP8 编码器要求偶数边长） */
function toEven(n: number): number {
  const v = Math.floor(n)
  return v % 2 === 0 ? v : v - 1
}

/**
 * 计算录制画布尺寸：等比缩放到上限内并对齐偶数。
 * 源尺寸非法（0 或 NaN）时回退 1280x720。
 */
export function computeCaptureSize(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number = MAX_CAPTURE_WIDTH,
  maxHeight: number = MAX_CAPTURE_HEIGHT,
): { width: number; height: number } {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth < 2 ||
    sourceHeight < 2
  ) {
    return { width: 1280, height: 720 }
  }
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight)
  const width = Math.max(2, toEven(sourceWidth * scale))
  const height = Math.max(2, toEven(sourceHeight * scale))
  return { width, height }
}

/**
 * 判断采样像素是否为空帧（几乎全黑或全白）。
 * 传入 canvas getImageData 的 RGBA 数据（建议缩放到 32x18 后采样）。
 */
export function isBlankFrame(pixels: Uint8ClampedArray): boolean {
  const total = Math.floor(pixels.length / 4)
  if (total === 0) return false

  let dark = 0
  let light = 0
  for (let i = 0; i < total; i++) {
    const r = pixels[i * 4]!
    const g = pixels[i * 4 + 1]!
    const b = pixels[i * 4 + 2]!
    if (r <= DARK_MAX && g <= DARK_MAX && b <= DARK_MAX) dark += 1
    else if (r >= LIGHT_MIN && g >= LIGHT_MIN && b >= LIGHT_MIN) light += 1
  }

  const ratio = Math.max(dark, light) / total
  return ratio >= BLANK_PIXEL_RATIO
}
