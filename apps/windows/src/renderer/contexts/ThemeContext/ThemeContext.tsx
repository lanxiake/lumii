/**
 * ThemeContext - 主题切换上下文
 *
 * 管理当前主题（light / dark / eye-care），支持监听系统主题变化
 */

import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react'

/**
 * 主题类型
 */
export type Theme = 'light' | 'dark' | 'eye-care' | 'system'

/**
 * 实际应用的主题模式（system 已按系统偏好解析）
 */
export type AppliedTheme = 'light' | 'dark' | 'eye-care'

/** 合法主题值；loadTheme / 设置同步都拿它做校验，新增主题只改这里 */
const THEME_VALUES: readonly Theme[] = ['light', 'dark', 'eye-care', 'system']

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEME_VALUES as readonly string[]).includes(value)
}

/**
 * 主题状态
 */
export interface ThemeState {
  /** 当前选择的主题 */
  theme: Theme
  /** 实际应用的主题（system 时根据系统主题确定） */
  appliedTheme: AppliedTheme
  /** 是否跟随系统主题 */
  isSystemTheme: boolean
}

/**
 * 主题上下文类型
 */
interface ThemeContextType extends ThemeState {
  /** 切换主题（浅色 → 护眼 → 深色 循环） */
  toggleTheme: () => void
  /** 设置指定主题 */
  setTheme: (theme: Theme) => void
  /** 设置为 light 主题 */
  setLightTheme: () => void
  /** 设置为 dark 主题 */
  setDarkTheme: () => void
  /** 设置为跟随系统主题 */
  setSystemTheme: () => void
}

// localStorage key
const STORAGE_KEY = 'mtbot_theme'
const SETTINGS_STORAGE_KEY = 'mtbot-assistant-settings'

/**
 * 从 localStorage 加载主题设置
 * 优先从 useSettings 的存储读取,保持数据一致性
 */
function loadTheme(): Theme {
  // 尝试从 useSettings 存储读取
  try {
    const settingsStored = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (settingsStored) {
      const settings = JSON.parse(settingsStored)
      if (isTheme(settings.theme?.mode)) {
        return settings.theme.mode
      }
    }
  } catch (error) {
    console.warn('[ThemeContext] 从 settings 存储读取主题失败:', error)
  }

  // 回退到独立存储
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isTheme(stored)) {
      return stored
    }
  } catch (error) {
    console.error('[ThemeContext] 加载主题设置失败:', error)
  }
  return 'system'
}

/**
 * 保存主题设置到 localStorage
 * 同时更新 useSettings 存储,保持数据一致性
 */
function persistTheme(theme: Theme): void {
  // 更新独立存储
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch (error) {
    console.error('[ThemeContext] 保存主题设置失败:', error)
  }

  // 同步到 useSettings 存储
  try {
    const settingsStored = localStorage.getItem(SETTINGS_STORAGE_KEY)
    const settings = settingsStored ? JSON.parse(settingsStored) : {}
    if (!settings.theme) {
      settings.theme = {}
    }
    settings.theme.mode = theme
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    // 触发自定义事件通知其他组件
    window.dispatchEvent(new CustomEvent('mtbot-settings-update'))
  } catch (error) {
    console.warn('[ThemeContext] 同步主题到 settings 存储失败:', error)
  }
}

/**
 * 获取系统主题偏好
 */
function getSystemTheme(): AppliedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return 'light'
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 计算实际应用的主题
 */
function calculateAppliedTheme(theme: Theme): AppliedTheme {
  if (theme === 'system') {
    return getSystemTheme()
  }
  return theme
}

// 创建上下文
const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

/**
 * ThemeProvider Props
 */
interface ThemeProviderProps {
  children: ReactNode
  /** 是否应用主题到 document.body */
  applyToBody?: boolean
  /** 自定义主题 CSS 类名前缀 */
  themeClassPrefix?: string
}

/**
 * ThemeProvider - 主题状态提供者
 */
export const ThemeProvider: React.FC<ThemeProviderProps> = ({
  children,
  applyToBody = true,
  themeClassPrefix = 'theme-',
}) => {
  const initialTheme = loadTheme()
  const [state, setState] = useState<ThemeState>({
    theme: initialTheme,
    appliedTheme: calculateAppliedTheme(initialTheme),
    isSystemTheme: initialTheme === 'system',
  })

  /**
   * 应用主题到 DOM
   */
  const applyThemeToDOM = useCallback((appliedTheme: AppliedTheme) => {
    if (!applyToBody || typeof document === 'undefined') {
      return
    }

    // 主: 设置在 <html> 根元素，使 [data-theme] CSS 选择器生效
    document.documentElement.setAttribute('data-theme', appliedTheme)

    // 兼容: 保留 body class 和 data-theme，不影响现有样式引用
    const body = document.body
    for (const cls of ['theme-light', 'theme-dark', 'theme-eye-care']) {
      body.classList.remove(cls)
    }
    body.classList.add(`${themeClassPrefix}${appliedTheme}`)
    body.setAttribute('data-theme', appliedTheme)

    console.log('[ThemeContext] 主题已应用:', appliedTheme)
  }, [applyToBody, themeClassPrefix])

  /**
   * 更新主题状态并应用
   */
  const updateTheme = useCallback((newTheme: Theme) => {
    const appliedTheme = calculateAppliedTheme(newTheme)

    setState({
      theme: newTheme,
      appliedTheme,
      isSystemTheme: newTheme === 'system',
    })

    persistTheme(newTheme)
    applyThemeToDOM(appliedTheme)

    console.log('[ThemeContext] 主题已切换:', newTheme, '->', appliedTheme)
  }, [applyThemeToDOM])

  /**
   * 切换主题（按 浅色 → 护眼 → 深色 循环；跟随系统态下从当前生效值起步）
   */
  const toggleTheme = useCallback(() => {
    const order: AppliedTheme[] = ['light', 'eye-care', 'dark']
    const idx = order.indexOf(state.appliedTheme)
    const newTheme: Theme = order[(idx + 1) % order.length]
    updateTheme(newTheme)
  }, [state.appliedTheme, updateTheme])

  /**
   * 设置指定主题
   */
  const setTheme = useCallback((theme: Theme) => {
    updateTheme(theme)
  }, [updateTheme])

  /**
   * 设置为 light 主题
   */
  const setLightTheme = useCallback(() => {
    updateTheme('light')
  }, [updateTheme])

  /**
   * 设置为 dark 主题
   */
  const setDarkTheme = useCallback(() => {
    updateTheme('dark')
  }, [updateTheme])

  /**
   * 设置为跟随系统主题
   */
  const setSystemTheme = useCallback(() => {
    updateTheme('system')
  }, [updateTheme])

  /**
   * 监听系统主题变化
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleSystemThemeChange = (event: MediaQueryListEvent | MediaQueryList) => {
      if (state.theme === 'system') {
        const newSystemTheme = 'matches' in event && event.matches ? 'dark' : 'light'
        console.log('[ThemeContext] 系统主题变化:', newSystemTheme)

        setState(prev => ({
          ...prev,
          appliedTheme: newSystemTheme,
        }))

        applyThemeToDOM(newSystemTheme)
      }
    }

    // 初始应用
    applyThemeToDOM(state.appliedTheme)

    // 监听系统主题变化
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleSystemThemeChange)
    } else {
      // 兼容旧版浏览器
      mediaQuery.addListener(handleSystemThemeChange)
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleSystemThemeChange)
      } else {
        mediaQuery.removeListener(handleSystemThemeChange)
      }
    }
  }, [applyThemeToDOM, state.appliedTheme, state.theme])

  /**
   * 监听设置更新事件,实现与 useSettings 的双向同步
   */
  useEffect(() => {
    const handleSettingsUpdate = () => {
      try {
        const settingsStored = localStorage.getItem(SETTINGS_STORAGE_KEY)
        if (settingsStored) {
          const settings = JSON.parse(settingsStored)
          if (isTheme(settings.theme?.mode)) {
            const newTheme = settings.theme.mode
            // 仅当主题发生变化时才更新
            setState(prev => {
              if (prev.theme !== newTheme) {
                const appliedTheme = calculateAppliedTheme(newTheme)
                applyThemeToDOM(appliedTheme)
                return {
                  theme: newTheme,
                  appliedTheme,
                  isSystemTheme: newTheme === 'system',
                }
              }
              return prev
            })
          }
        }
      } catch (error) {
        console.warn('[ThemeContext] 监听设置更新失败:', error)
      }
    }

    window.addEventListener('mtbot-settings-update', handleSettingsUpdate)
    return () => window.removeEventListener('mtbot-settings-update', handleSettingsUpdate)
  }, [applyThemeToDOM])

  const value: ThemeContextType = {
    ...state,
    toggleTheme,
    setTheme,
    setLightTheme,
    setDarkTheme,
    setSystemTheme,
  }

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/**
 * useTheme Hook - 使用主题上下文
 */
export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}

export default ThemeContext
