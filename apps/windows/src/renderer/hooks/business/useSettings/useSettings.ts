/**
 * useSettings.ts - 设置管理 Hook
 *
 * 基于 useSettings.ts 重构
 * 管理工作空间设置和应用配置
 */

import { useState, useEffect, useCallback } from 'react'
import type {
  AppSettings,
  ThemeConfig,
  NotificationConfig,
  PrivacyConfig,
  ShortcutConfig,
  WorkspaceConfig,
  WindowConfig,
  SystemConfig,
  MemoryConfig,
} from './useSettings.types'

/** localStorage 中应用设置的存储 key（渲染进程与主进程读取需保持一致） */
export const SETTINGS_STORAGE_KEY = 'mtbot-assistant-settings'
/** SettingsContext 遗留 key，迁移时读取后合并 */
const LEGACY_STORAGE_KEY = 'mtbot_app_settings'
/** 设置变更后广播的事件名 */
export const SETTINGS_UPDATE_EVENT = 'mtbot-settings-update'

const STORAGE_KEY = SETTINGS_STORAGE_KEY

const DEFAULT_SETTINGS: AppSettings = {
  theme: {
    mode: 'dark',
    primaryColor: '#6366f1',
    fontSize: 'medium',
    enableAnimations: true,
  },
  notification: {
    enabled: true,
    soundEnabled: true,
    showPreview: true,
    desktopNotification: true,
  },
  privacy: {
    sendUsageStats: false,
    saveChatHistory: true,
    historyRetentionDays: 30,
    allowAgentAppUiControl: true,
  },
  shortcuts: {
    sendMessage: 'Enter',
    newChat: 'Ctrl+N',
    toggleSidebar: 'Ctrl+B',
    openSettings: 'Ctrl+,',
    toggleWindow: 'CmdOrCtrl+Shift+M',
    quickChat: 'CmdOrCtrl+Shift+C',
    screenshot: 'CmdOrCtrl+Shift+S',
  },
  workspace: {
    directory: '',
  },
  window: {
    opacity: 1,
    sidebarWidth: 280,
  },
  system: {
    autoStart: false,
    minimizeToTray: true,
    showSplashOnStartup: true,
  },
  memory: {
    injectPersonalMemory: true,
    injectWorkMemory: true,
  },
  screenRecord: {
    enabled: true,
    alwaysAllow: false,
    includeMicDefault: true,
    includeSystemAudioDefault: true,
    exportMp4Default: false,
    narrateOriginalAudioGain: 0.35,
    confirmTimeoutSec: 120,
  },
  language: 'zh-CN',
  checkUpdateOnStartup: true,
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target } as T

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const targetValue = target[key as keyof T]
      const sourceValue = source[key as keyof T]

      if (
        typeof targetValue === 'object' &&
        targetValue !== null &&
        !Array.isArray(targetValue) &&
        typeof sourceValue === 'object' &&
        sourceValue !== null &&
        !Array.isArray(sourceValue)
      ) {
        ;(result as Record<string, unknown>)[key] = deepMerge(
          targetValue as object,
          sourceValue as Partial<typeof targetValue>
        )
      } else if (sourceValue !== undefined) {
        ;(result as Record<string, unknown>)[key] = sourceValue
      }
    }
  }

  return result
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [savedSettings, setSavedSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [isLoading, setIsLoading] = useState(true)

  // 初始加载设置（含旧 SettingsContext key 迁移）
  useEffect(() => {
    async function loadSettings() {
      try {
        // 独立版：不拉取远程配置，仅用本地默认值
        const effectiveDefaults: AppSettings = { ...DEFAULT_SETTINGS }

        const stored = localStorage.getItem(STORAGE_KEY)
        let base: Partial<AppSettings> = {}

        // 迁移旧 SettingsContext 数据（仅在新 key 不存在时）
        if (!stored) {
          const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
          if (legacy) {
            try {
              const legacyParsed = JSON.parse(legacy) as Record<string, unknown>
              // 映射旧字段到新结构
              base = {
                theme: legacyParsed.theme
                  ? { ...effectiveDefaults.theme, mode: legacyParsed.theme as AppSettings['theme']['mode'] }
                  : undefined,
                language: legacyParsed.language as AppSettings['language'] | undefined,
                window: {
                  opacity: typeof legacyParsed.windowOpacity === 'number' ? legacyParsed.windowOpacity : effectiveDefaults.window.opacity,
                  sidebarWidth: typeof legacyParsed.sidebarWidth === 'number' ? legacyParsed.sidebarWidth : effectiveDefaults.window.sidebarWidth,
                },
                system: {
                  autoStart: typeof legacyParsed.autoStart === 'boolean' ? legacyParsed.autoStart : effectiveDefaults.system.autoStart,
                  minimizeToTray: typeof legacyParsed.minimizeToTray === 'boolean' ? legacyParsed.minimizeToTray : effectiveDefaults.system.minimizeToTray,
                },
                notification: {
                  ...effectiveDefaults.notification,
                  enabled: typeof legacyParsed.showNotifications === 'boolean' ? legacyParsed.showNotifications : effectiveDefaults.notification.enabled,
                  soundEnabled: typeof legacyParsed.notificationSound === 'boolean' ? legacyParsed.notificationSound : effectiveDefaults.notification.soundEnabled,
                },
                shortcuts: legacyParsed.shortcuts
                  ? { ...effectiveDefaults.shortcuts, ...(legacyParsed.shortcuts as Partial<AppSettings['shortcuts']>) }
                  : undefined,
              }
              // 迁移完成后删除旧 key
              localStorage.removeItem(LEGACY_STORAGE_KEY)
            } catch {
              // 旧数据解析失败，忽略
            }
          }
        } else {
          base = JSON.parse(stored) as Partial<AppSettings>
        }

        const merged = deepMerge(effectiveDefaults, base)
        setSettings(merged)
        setSavedSettings(merged)
        void window.electronAPI?.settings?.updateMemoryInjection?.({
          injectPersonalMemory: merged.memory?.injectPersonalMemory !== false,
          injectWorkMemory: merged.memory?.injectWorkMemory !== false,
        })
      } catch (error) {
        console.error('[useSettings] 解析设置失败:', error)
      }
      setIsLoading(false)
    }

    loadSettings()
  }, [])

  // 监听其他组件的设置更新事件
  useEffect(() => {
    const handleSettingsUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<AppSettings | null | undefined>
      if (customEvent.detail != null) {
        // 事件携带了完整的 settings 对象，直接使用
        setSettings(customEvent.detail)
        setSavedSettings(customEvent.detail)
      } else {
        // 事件仅作通知（如 ThemeContext 同步），从 localStorage 重新加载
        const stored = localStorage.getItem(STORAGE_KEY)
        if (stored) {
          try {
            const parsed = JSON.parse(stored) as Partial<AppSettings>
            setSettings((prev) => deepMerge(prev, parsed))
            setSavedSettings((prev) => deepMerge(prev, parsed))
          } catch {
            // 解析失败，保持当前状态
          }
        }
      }
    }

    window.addEventListener(SETTINGS_UPDATE_EVENT, handleSettingsUpdate)
    return () => window.removeEventListener(SETTINGS_UPDATE_EVENT, handleSettingsUpdate)
  }, [])

  const hasChanges = JSON.stringify(settings) !== JSON.stringify(savedSettings)

  /** 更新设置 */
  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }))
  }, [])

  /** 更新主题配置 */
  const updateTheme = useCallback((config: Partial<ThemeConfig>) => {
    setSettings((prev) => ({
      ...prev,
      theme: { ...prev.theme, ...config },
    }))
  }, [])

  /** 更新通知配置 */
  const updateNotification = useCallback((config: Partial<NotificationConfig>) => {
    setSettings((prev) => ({
      ...prev,
      notification: { ...prev.notification, ...config },
    }))
  }, [])

  /** 更新隐私配置 */
  const updatePrivacy = useCallback((config: Partial<PrivacyConfig>) => {
    setSettings((prev) => ({
      ...prev,
      privacy: { ...prev.privacy, ...config },
    }))
  }, [])

  /** 更新快捷键配置 */
  const updateShortcuts = useCallback((config: Partial<ShortcutConfig>) => {
    setSettings((prev) => ({
      ...prev,
      shortcuts: { ...prev.shortcuts, ...config },
    }))
  }, [])

  /** 更新工作空间配置 */
  const updateWorkspace = useCallback((config: Partial<WorkspaceConfig>) => {
    setSettings((prev) => ({
      ...prev,
      workspace: { ...prev.workspace, ...config },
    }))
  }, [])

  /** 更新窗口配置 */
  const updateWindow = useCallback((config: Partial<WindowConfig>) => {
    setSettings((prev) => ({
      ...prev,
      window: { ...prev.window, ...config },
    }))
  }, [])

  /** 更新系统配置 */
  const updateSystem = useCallback((config: Partial<SystemConfig>) => {
    setSettings((prev) => ({
      ...prev,
      system: { ...prev.system, ...config },
    }))
  }, [])

  /** 更新记忆注入配置 */
  const updateMemory = useCallback((config: Partial<MemoryConfig>) => {
    setSettings((prev) => ({
      ...prev,
      memory: { ...DEFAULT_SETTINGS.memory, ...prev.memory, ...config },
    }))
  }, [])

  /** 保存设置 */
  const saveSettings = useCallback(async () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
      setSavedSettings(settings)

      const event = new CustomEvent(SETTINGS_UPDATE_EVENT, { detail: settings })
      window.dispatchEvent(event)
    } catch (error) {
      console.error('[useSettings] 保存设置失败:', error)
      throw error
    }
  }, [settings])

  /** 重置为默认设置 */
  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS)
  }, [])

  /** 导出设置 */
  const exportSettings = useCallback(() => {
    return JSON.stringify(settings, null, 2)
  }, [settings])

  /** 导入设置 */
  const importSettings = useCallback((json: string): boolean => {
    try {
      const imported = JSON.parse(json) as Partial<AppSettings>
      const merged = deepMerge(DEFAULT_SETTINGS, imported)
      setSettings(merged)
      return true
    } catch (error) {
      console.error('[useSettings] 导入设置失败:', error)
      return false
    }
  }, [])

  return {
    settings,
    isLoading,
    hasChanges,
    updateSettings,
    updateTheme,
    updateNotification,
    updatePrivacy,
    updateShortcuts,
    updateWorkspace,
    updateWindow,
    updateSystem,
    updateMemory,
    saveSettings,
    resetSettings,
    exportSettings,
    importSettings,
  }
}

export type UseSettingsReturn = ReturnType<typeof useSettings>
