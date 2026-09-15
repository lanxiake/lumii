/**
 * useSettings.ts - 设置管理 Hook
 *
 * 默认值/深合并/存储读取在 settings-core.ts；本 hook 只留状态壳与动作。
 */

import { useState, useEffect, useCallback } from 'react'
import type {
  AppSettings,
  NotificationConfig,
  PrivacyConfig,
  WorkspaceConfig,
  SystemConfig,
  MemoryConfig,
} from './useSettings.types'
import { updateMemoryInjection, updatePromptStyle } from '../../../services/settings-service'
import { normalizePromptStyle } from '../../../../shared/prompt-style'
import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_UPDATE_EVENT,
  DEFAULT_SETTINGS,
  deepMerge,
  loadInitialSettings,
  readStoredSettings,
} from './settings-core'

/**
 * 把 localStorage 中「主进程需要感知」的设置同步到主进程缓存。
 *
 * 覆盖记忆注入开关与提示词风格（实验）。任何设置变更事件（本组件保存 / 其他
 * 组件广播 / app-ui CLI /settings/write 直写）都应调用本函数——主进程缓存
 * 只在 IPC 推送时更新，缺了这步会出现 CLI 改设置但每轮提示词仍读旧值。
 */
function syncSettingsToMain(): void {
  try {
    const stored = readStoredSettings()
    void updateMemoryInjection({
      injectPersonalMemory: stored?.memory?.injectPersonalMemory !== false,
      injectWorkMemory: stored?.memory?.injectWorkMemory !== false,
    })
    void updatePromptStyle({
      style: normalizePromptStyle(stored?.promptStyle?.style),
    })
  } catch {
    // 忽略本地读取失败（主进程侧各自有默认值兜底）
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)

  // 初始加载设置（含旧 SettingsContext key 迁移）
  useEffect(() => {
    try {
      const merged = loadInitialSettings()
      setSettings(merged)
      syncSettingsToMain()
    } catch (error) {
      console.error('[useSettings] 解析设置失败:', error)
    }
  }, [])

  // 监听其他组件的设置更新事件
  useEffect(() => {
    const handleSettingsUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<AppSettings | null | undefined>
      if (customEvent.detail != null) {
        // 事件携带了完整的 settings 对象，直接使用
        setSettings(customEvent.detail)
      } else {
        // 事件仅作通知（如 ThemeContext 同步），从 localStorage 重新加载
        const parsed = readStoredSettings()
        if (parsed) {
          setSettings((prev) => deepMerge(prev, parsed))
        }
      }
      // 任何来源的设置变更（含 app-ui CLI /settings/write 直写）都同步主进程缓存，
      // 否则主进程缓存陈旧，每轮提示词读取到旧值
      syncSettingsToMain()
    }

    window.addEventListener(SETTINGS_UPDATE_EVENT, handleSettingsUpdate)
    return () => window.removeEventListener(SETTINGS_UPDATE_EVENT, handleSettingsUpdate)
  }, [])

  /** 更新设置 */
  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }))
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

  /** 更新工作空间配置 */
  const updateWorkspace = useCallback((config: Partial<WorkspaceConfig>) => {
    setSettings((prev) => ({
      ...prev,
      workspace: { ...prev.workspace, ...config },
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

  /** 保存设置（闭包持有本次渲染的 settings；同一事件里先 update 再 save 会写入旧值） */
  const saveSettings = useCallback(async () => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))

      const event = new CustomEvent(SETTINGS_UPDATE_EVENT, { detail: settings })
      window.dispatchEvent(event)
    } catch (error) {
      console.error('[useSettings] 保存设置失败:', error)
      throw error
    }
  }, [settings])

  return {
    settings,
    updateSettings,
    updateNotification,
    updatePrivacy,
    updateWorkspace,
    updateSystem,
    updateMemory,
    saveSettings,
  }
}

export type UseSettingsReturn = ReturnType<typeof useSettings>
