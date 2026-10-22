/**
 * 设置和记忆注入相关 IPC handlers
 */
import { ipcMain } from 'electron'

interface SettingsIpcDeps {
  setMemoryInjectionSettings: (settings: {
    injectPersonalMemory?: boolean
    injectWorkMemory?: boolean
  }) => void
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

  // 系统提示词风格已插件化（`plugins/builtin/prompt-style`）：
  // 通道 `settings:updatePromptStyle` 由插件在自己的作用域里注册，停用随作用域摘掉。
}
