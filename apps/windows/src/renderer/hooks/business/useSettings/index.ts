/**
 * useSettings/index.ts - 设置管理统一导出
 */

export { useSettings, SETTINGS_STORAGE_KEY, SETTINGS_UPDATE_EVENT } from './useSettings'
export { useCategorySettings } from './useCategorySettings'
export type { UseSettingsReturn } from './useSettings'
export type {
  AppSettings,
  ThemeConfig,
  NotificationConfig,
  PrivacyConfig,
  ShortcutConfig,
  WorkspaceConfig,
} from './useSettings.types'
