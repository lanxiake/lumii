/**
 * AppFontScaleContext - 全局 UI 字号（小 / 中 / 大）
 *
 * 沿用原对话页三档字号：点击 TitleBar Type 图标循环切换。
 * 通过改写 :root 字体 CSS 变量，统一控制全应用文字大小。
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/** 与原对话页 `mtbot:chat-font-scale` 对齐；同时兼容旧全局 key */
const STORAGE_KEY = 'mtbot:app-font-scale'
const LEGACY_CHAT_KEY = 'mtbot:chat-font-scale'

export type FontScaleLevel = 'small' | 'medium' | 'large'

const LEVELS: readonly FontScaleLevel[] = ['small', 'medium', 'large']

const LEVEL_LABEL: Record<FontScaleLevel, string> = {
  small: '小',
  medium: '中',
  large: '大',
}

/** 相对 medium 的倍率；仅三档，不提供连续百分比 */
const LEVEL_FACTOR: Record<FontScaleLevel, number> = {
  small: 0.875,
  medium: 1,
  large: 1.125,
}

/** 对话消息区字号（与原 ChatPage FONT_SCALE_PX 一致） */
const CHAT_FONT_PX: Record<FontScaleLevel, number> = {
  small: 13,
  medium: 15,
  large: 17,
}

/**
 * 基准字号（px，medium 档）。缩放时按 LEVEL_FACTOR 重写到 documentElement。
 */
const FONT_VAR_BASES: Readonly<Record<string, number>> = {
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

interface AppFontScaleContextType {
  /** 当前档位 */
  level: FontScaleLevel
  /** 档位中文标签 */
  label: string
  /** 循环切换：小 → 中 → 大 → 小 */
  cycle: () => void
}

const AppFontScaleContext = createContext<AppFontScaleContextType | null>(null)

/**
 * 解析合法档位；兼容旧版数值倍率（映射到最近档）
 */
function parseLevel(raw: string | null): FontScaleLevel | null {
  if (!raw) return null
  if (raw === 'small' || raw === 'medium' || raw === 'large') return raw
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return null
  if (n < 0.94) return 'small'
  if (n > 1.06) return 'large'
  return 'medium'
}

/**
 * 从 localStorage 读取字号档位
 */
function loadLevel(): FontScaleLevel {
  try {
    const fromApp = parseLevel(localStorage.getItem(STORAGE_KEY))
    if (fromApp) return fromApp
    const fromChat = parseLevel(localStorage.getItem(LEGACY_CHAT_KEY))
    if (fromChat) return fromChat
  } catch {
    /* ignore */
  }
  return 'medium'
}

/**
 * 把三档字号写到 documentElement
 */
function applyFontLevel(level: FontScaleLevel): void {
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
function persistLevel(level: FontScaleLevel): void {
  try {
    localStorage.setItem(STORAGE_KEY, level)
    localStorage.setItem(LEGACY_CHAT_KEY, level)
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * 下一档：小 → 中 → 大 → 小
 */
function nextLevel(current: FontScaleLevel): FontScaleLevel {
  const idx = LEVELS.indexOf(current)
  return LEVELS[(idx + 1) % LEVELS.length]
}

export interface AppFontScaleProviderProps {
  children: ReactNode
}

/**
 * 全局字号 Provider：启动时恢复档位，并向子树提供循环切换 API
 */
export const AppFontScaleProvider: React.FC<AppFontScaleProviderProps> = ({ children }) => {
  const [level, setLevel] = useState<FontScaleLevel>(() => loadLevel())

  useLayoutEffect(() => {
    applyFontLevel(level)
  }, [level])

  const cycle = useCallback(() => {
    setLevel((prev) => {
      const next = nextLevel(prev)
      persistLevel(next)
      return next
    })
  }, [])

  const value = useMemo<AppFontScaleContextType>(
    () => ({
      level,
      label: LEVEL_LABEL[level],
      cycle,
    }),
    [level, cycle],
  )

  return (
    <AppFontScaleContext.Provider value={value}>
      {children}
    </AppFontScaleContext.Provider>
  )
}

/**
 * 读取全局字号 API
 */
export function useAppFontScale(): AppFontScaleContextType {
  const ctx = useContext(AppFontScaleContext)
  if (!ctx) {
    throw new Error('useAppFontScale must be used within AppFontScaleProvider')
  }
  return ctx
}

export default AppFontScaleContext
