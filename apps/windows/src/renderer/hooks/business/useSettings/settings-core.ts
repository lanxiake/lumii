/**
 * settings-core.ts — 设置非 React 核心
 *
 * 默认值、深合并与本地存储读取（含旧 SettingsContext key 迁移）；
 * useSettings 只留状态壳与动作。
 */

import type { AppSettings } from './useSettings.types'

/** localStorage 中应用设置的存储 key（渲染进程与主进程读取需保持一致） */
export const SETTINGS_STORAGE_KEY = 'mtbot-assistant-settings'
/** SettingsContext 遗留 key，迁移时读取后合并 */
const LEGACY_STORAGE_KEY = 'mtbot_app_settings'
/** 设置变更后广播的事件名 */
export const SETTINGS_UPDATE_EVENT = 'mtbot-settings-update'

const STORAGE_KEY = SETTINGS_STORAGE_KEY

export const DEFAULT_SETTINGS: AppSettings = {
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

export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
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

/** 读取已存设置并合并默认值（含旧 SettingsContext key 的一次性迁移）；解析失败抛出，由调用方兜底 */
export function loadInitialSettings(): AppSettings {
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
            showSplashOnStartup: effectiveDefaults.system.showSplashOnStartup,
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

  return deepMerge(effectiveDefaults, base)
}

/** 从存储回读设置局部对象（更新事件仅作通知时使用）；无存储或解析失败返回 null */
export function readStoredSettings(): Partial<AppSettings> | null {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return null
  try {
    return JSON.parse(stored) as Partial<AppSettings>
  } catch {
    return null
  }
}
