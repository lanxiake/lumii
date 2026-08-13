/**
 * 全局 UI 字号档位与倍率（小 / 中 / 大 / 超大）
 *
 * 以 medium 为 1，档位间距约 15%–25%，切换时肉眼可辨。
 */

/** 与原对话页 `mtbot:chat-font-scale` 对齐；同时兼容旧全局 key */
export const STORAGE_KEY = 'mtbot:app-font-scale'
export const LEGACY_CHAT_KEY = 'mtbot:chat-font-scale'

export type FontScaleLevel = 'small' | 'medium' | 'large' | 'xlarge'

/** 无本地存储时的默认档位 */
export const DEFAULT_FONT_SCALE_LEVEL: FontScaleLevel = 'medium'

export const LEVELS: readonly FontScaleLevel[] = ['small', 'medium', 'large', 'xlarge']

export const LEVEL_LABEL: Record<FontScaleLevel, string> = {
  small: '小',
  medium: '中',
  large: '大',
  xlarge: '超大',
}

/** 相对 medium 的倍率；四档离散值，不提供连续百分比 */
export const LEVEL_FACTOR: Record<FontScaleLevel, number> = {
  small: 0.85,
  medium: 1,
  large: 1.25,
  xlarge: 1.5,
}

/** 对话消息区字号（px）；中档与历史默认 15px 对齐 */
export const CHAT_FONT_PX: Record<FontScaleLevel, number> = {
  small: 13,
  medium: 15,
  large: 19,
  xlarge: 23,
}

/**
 * 基准字号（px，medium 档）。缩放时按 LEVEL_FACTOR 重写到 documentElement。
 */
export const FONT_VAR_BASES: Readonly<Record<string, number>> = {
  '--font-size-xs': 12,
  '--font-size-sm': 14,
  '--font-size-base': 16,
  '--font-size-lg': 18,
  '--font-size-xl': 20,
  '--font-size-2xl': 24,
  '--font-size-3xl': 30,
  '--font-size-4xl': 36,
  '--font-size-5xl': 48,
  '--mt-fs-xs': 12,
  '--mt-fs-sm': 14,
  '--mt-fs-base': 16,
  '--mt-fs-lg': 18,
  '--mt-fs-xl': 20,
  '--mt-fs-2xl': 24,
  '--mt-fs-3xl': 30,
  '--mt-fs-4xl': 36,
  '--mt-fs-5xl': 48,
  '--mt-fs-6xl': 64,
}

/**
 * 解析合法档位；兼容旧版数值倍率（映射到最近档）
 */
export function parseLevel(raw: string | null): FontScaleLevel | null {
  if (!raw) return null
  if (raw === 'small' || raw === 'medium' || raw === 'large' || raw === 'xlarge') {
    return raw
  }
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return null
  if (n < 0.925) return 'small'
  if (n < 1.125) return 'medium'
  if (n < 1.375) return 'large'
  return 'xlarge'
}

/**
 * 从 localStorage 读取字号档位，缺省为中
 */
export function loadLevel(): FontScaleLevel {
  try {
    const fromApp = parseLevel(localStorage.getItem(STORAGE_KEY))
    if (fromApp) return fromApp
    const fromChat = parseLevel(localStorage.getItem(LEGACY_CHAT_KEY))
    if (fromChat) return fromChat
  } catch {
    /* ignore */
  }
  return DEFAULT_FONT_SCALE_LEVEL
}

/**
 * 把四档字号写到 documentElement
 */
export function applyFontLevel(level: FontScaleLevel): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const factor = LEVEL_FACTOR[level]
  root.style.setProperty('--app-font-scale', String(factor))
  root.dataset.fontScale = level
  for (const [key, base] of Object.entries(FONT_VAR_BASES)) {
    const px = Math.round(base * factor * 10) / 10
    root.style.setProperty(key, `${px}px`)
  }
  root.style.setProperty('--chat-font-size', `${CHAT_FONT_PX[level]}px`)
}

/**
 * 持久化字号档位
 */
export function persistLevel(level: FontScaleLevel): void {
  try {
    localStorage.setItem(STORAGE_KEY, level)
    localStorage.setItem(LEGACY_CHAT_KEY, level)
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * 下一档：小 → 中 → 大 → 超大 → 小
 */
export function nextLevel(current: FontScaleLevel): FontScaleLevel {
  const idx = LEVELS.indexOf(current)
  return LEVELS[(idx + 1) % LEVELS.length]
}
