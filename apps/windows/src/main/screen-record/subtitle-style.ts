/**
 * 字幕外观样式：归一化与 ASS force_style 生成
 *
 * SRT 本身不带样式，libass 按内置默认值（PlayResY=288、FontSize=16、白字无描边）渲染，
 * 在 720p/1080p 成片上字号极小且浅色画面上看不清，因此烧录时必须显式覆盖。
 */
import {
  SCREEN_RECORD_SUBTITLE_STYLE_DEFAULTS,
  type ScreenRecordSubtitleStyle,
} from '../../shared/screen-record'

/** 字号可选区间（ASS 基准，非最终像素） */
export const SUBTITLE_FONT_SIZE_MIN = 10
export const SUBTITLE_FONT_SIZE_MAX = 120
/** 描边宽度上限 */
const OUTLINE_MAX = 8

/** 烧录使用的中文字体名（配合 fontsdir 指向系统字体目录） */
export const SUBTITLE_FONT_NAME = 'Microsoft YaHei'

/**
 * #RRGGBB → ASS 颜色字面量 &HAABBGGRR（ASS 为 BGR 序，AA=00 表示不透明）。
 * 解析失败时回退白色，避免生成非法 force_style 让整条烧录失败。
 */
export function hexToAssColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim())
  if (!m) return '&H00FFFFFF'
  const rgb = m[1]!.toUpperCase()
  const r = rgb.slice(0, 2)
  const g = rgb.slice(2, 4)
  const b = rgb.slice(4, 6)
  return `&H00${b}${g}${r}`
}

/** 数值夹取，非法值回退默认 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 补全并夹取样式字段，容忍历史项目文件里缺字段或脏数据。
 */
export function normalizeSubtitleStyle(
  style: Partial<ScreenRecordSubtitleStyle> | undefined | null,
): ScreenRecordSubtitleStyle {
  const d = SCREEN_RECORD_SUBTITLE_STYLE_DEFAULTS
  if (!style) return { ...d }
  const color = /^#?[0-9a-f]{6}$/i.test((style.primaryColor ?? '').trim())
    ? `#${style.primaryColor!.trim().replace(/^#/, '').toUpperCase()}`
    : d.primaryColor
  return {
    fontSize: clamp(style.fontSize, SUBTITLE_FONT_SIZE_MIN, SUBTITLE_FONT_SIZE_MAX, d.fontSize),
    primaryColor: color,
    outline: clamp(style.outline, 0, OUTLINE_MAX, d.outline),
  }
}

/**
 * 生成 ffmpeg subtitles 滤镜的 force_style 值。
 * 结果不含单引号，可安全嵌入 `force_style='...'`。
 */
export function buildSubtitleForceStyle(
  style: Partial<ScreenRecordSubtitleStyle> | undefined | null,
): string {
  const s = normalizeSubtitleStyle(style)
  return [
    `FontName=${SUBTITLE_FONT_NAME}`,
    `FontSize=${s.fontSize}`,
    `PrimaryColour=${hexToAssColor(s.primaryColor)}`,
    'OutlineColour=&H00000000',
    'BorderStyle=1',
    `Outline=${s.outline}`,
    'Shadow=0',
  ].join(',')
}
