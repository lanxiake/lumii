/**
 * AppFontScaleContext - 全局 UI 字号缩放
 *
 * 通过改写 :root 上的字体 CSS 变量，统一放大/缩小整个应用的文字。
 * 控制入口在 TitleBar（A− / A+），与对话页解耦。
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

const STORAGE_KEY = 'mtbot:app-font-scale'
const SCALE_MIN = 0.8
const SCALE_MAX = 1.4
const SCALE_STEP = 0.1
const SCALE_DEFAULT = 1

/**
 * 基准字号（px）。缩放时按 scale 重写到 documentElement。
 * 与 tokens.css / design-system.css 中的默认值对齐。
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
  /** 对话消息区默认字号（原 medium 档） */
  '--chat-font-size': 15,
}

interface AppFontScaleContextType {
  /** 当前缩放倍率（1 = 默认） */
  scale: number
  /** 缩小一档 */
  decrease: () => void
  /** 放大一档 */
  increase: () => void
  /** 复位为默认 */
  reset: () => void
  canDecrease: boolean
  canIncrease: boolean
}

const AppFontScaleContext = createContext<AppFontScaleContextType | null>(null)

/**
 * 将倍率限制在合法区间，并按步进对齐
 */
function clampScale(value: number): number {
  const stepped = Math.round(value / SCALE_STEP) * SCALE_STEP
  const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, stepped))
  return Math.round(clamped * 100) / 100
}

/**
 * 从 localStorage 读取已保存的字号倍率
 */
function loadScale(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return SCALE_DEFAULT
    const parsed = parseFloat(raw)
    if (!Number.isFinite(parsed)) return SCALE_DEFAULT
    return clampScale(parsed)
  } catch {
    return SCALE_DEFAULT
  }
}

/**
 * 把字号 CSS 变量写到 documentElement
 */
function applyFontScale(scale: number): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--app-font-scale', String(scale))
  for (const [key, base] of Object.entries(FONT_VAR_BASES)) {
    const px = Math.round(base * scale * 10) / 10
    root.style.setProperty(key, `${px}px`)
  }
}

/**
 * 持久化字号倍率
 */
function persistScale(scale: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(scale))
  } catch {
    /* ignore quota / private mode */
  }
}

export interface AppFontScaleProviderProps {
  children: ReactNode
}

/**
 * 全局字号 Provider：启动时恢复倍率，并向子树提供增减 API
 */
export const AppFontScaleProvider: React.FC<AppFontScaleProviderProps> = ({ children }) => {
  const [scale, setScale] = useState<number>(() => loadScale())

  useLayoutEffect(() => {
    applyFontScale(scale)
  }, [scale])

  const decrease = useCallback(() => {
    setScale((prev) => {
      const next = clampScale(prev - SCALE_STEP)
      persistScale(next)
      return next
    })
  }, [])

  const increase = useCallback(() => {
    setScale((prev) => {
      const next = clampScale(prev + SCALE_STEP)
      persistScale(next)
      return next
    })
  }, [])

  const reset = useCallback(() => {
    persistScale(SCALE_DEFAULT)
    setScale(SCALE_DEFAULT)
  }, [])

  const value = useMemo<AppFontScaleContextType>(
    () => ({
      scale,
      decrease,
      increase,
      reset,
      canDecrease: scale > SCALE_MIN + 1e-9,
      canIncrease: scale < SCALE_MAX - 1e-9,
    }),
    [scale, decrease, increase, reset],
  )

  return (
    <AppFontScaleContext.Provider value={value}>
      {children}
    </AppFontScaleContext.Provider>
  )
}

/**
 * 读取全局字号缩放 API
 */
export function useAppFontScale(): AppFontScaleContextType {
  const ctx = useContext(AppFontScaleContext)
  if (!ctx) {
    throw new Error('useAppFontScale must be used within AppFontScaleProvider')
  }
  return ctx
}

export default AppFontScaleContext
