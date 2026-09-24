/**
 * useSettings/index.ts - 设置管理统一导出
 */

export { useSettings } from './useSettings'
export { SETTINGS_STORAGE_KEY, SETTINGS_UPDATE_EVENT, DEFAULT_SETTINGS, readStoredSettings } from './settings-core'
export { useCategorySettings } from './useCategorySettings'
export type { UseCategorySettingsReturn } from './useCategorySettings'
export type {
  AppSettings,
  WorkspaceConfig,
  ScreenRecordConfig,
} from './useSettings.types'
