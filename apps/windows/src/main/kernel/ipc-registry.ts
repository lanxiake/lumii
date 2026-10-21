/**
 * 主进程 IPC 注册器：供插件注册 IPC 处理器，卸载时自动清理。
 */
import { ipcMain } from 'electron'

export interface IpcRegistry {
  register(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void
  unregister(channel: string): void
}

/**
 * 创建 IPC 注册器。
 *
 * 幂等注册：同一通道重复注册时先摘掉旧的（热重载场景）。
 */
export function createIpcRegistry(): IpcRegistry {
  return {
    register(channel, handler) {
      // 热重载/重复注册：先摘掉旧的，否则抛 "Attempted to register a second handler"
      try {
        ipcMain.removeHandler(channel)
      } catch {
        // 首次注册：没有旧 handler，ignore
      }
      ipcMain.handle(channel, handler as any)
    },

    unregister(channel) {
      try {
        ipcMain.removeHandler(channel)
      } catch {
        // 已经被摘掉或从未注册，ignore
      }
    },
  }
}
