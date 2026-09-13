/**
 * 设置和记忆注入相关 IPC handlers
 */
import { ipcMain } from 'electron'

interface SettingsIpcDeps {
  setMemoryInjectionSettings: (settings: {
    injectPersonalMemory?: boolean
    injectWorkMemory?: boolean
  }) => void
  setPromptStyleSettings: (settings: { style?: 'detailed' | 'terse' }) => void
}

let deps: SettingsIpcDeps | null = null

export function setSettingsIpcDeps(d: SettingsIpcDeps): void {
  deps = d
}

export function registerSettingsIpcHandlers(): void {
  if (!deps) throw new Error('SettingsIpc deps not set')

  // === 记忆注入开关（主进程缓存，供 Agent 每轮 prompt 读取）===
  ipcMain.handle(
    'settings:updateMemoryInjection',
    async (_event, payload: { injectPersonalMemory?: boolean; injectWorkMemory?: boolean }) => {
      if (!payload || typeof payload !== 'object') return
      deps!.setMemoryInjectionSettings(payload)
    },
  )

  // === 系统提示词风格（实验功能；主进程缓存，供每轮 prompt 重建读取）===
  ipcMain.handle(
    'settings:updatePromptStyle',
    async (_event, payload: { style?: 'detailed' | 'terse' }) => {
      if (!payload || typeof payload !== 'object') return
      deps!.setPromptStyleSettings(payload)
    },
  )
}
