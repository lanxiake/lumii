/**
 * AppFontScaleContext - 全局 UI 字号（小 / 中 / 大 / 超大）
 *
 * 点击 TitleBar Type 图标循环切换。
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
import {
  applyFontLevel,
  LEVEL_LABEL,
  loadLevel,
  nextLevel,
  persistLevel,
  type FontScaleLevel,
} from './app-font-scale'

export type { FontScaleLevel }

interface AppFontScaleContextType {
  /** 当前档位 */
  level: FontScaleLevel
  /** 档位中文标签 */
  label: string
  /** 循环切换：小 → 中 → 大 → 超大 → 小 */
  cycle: () => void
}

const AppFontScaleContext = createContext<AppFontScaleContextType | null>(null)

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
