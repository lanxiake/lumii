/**
 * 主进程 IPC 注册器：供插件注册 IPC 处理器，卸载时自动清理。
 */
import { ipcMain } from 'electron'

export interface IpcRegistry {
  register(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void
  unregister(channel: string): void
  /** 单向消息（`ipcRenderer.send`）：随插件作用域移除 */
  registerListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  unregisterListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

/**
 * 「能不能注册 IPC」的最小接口。
 *
 * 各模块的注册函数默认直连 `ipcMain`（类型上可当成本接口用）；插件则传
 * `ctx.registerIpc` —— 通道挂在插件作用域上，停用时才会被真正摘掉。
 * `on` 是单向消息（`ipcRenderer.send`），同样是插件可选的扩展点。
 */
export interface IpcHandleRegistrar {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 与 Electron 的 handle 同形：具体参数类型在实现侧收窄
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
  on?(channel: string, listener: (event: unknown, ...args: any[]) => void): void
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

    registerListener(channel, listener) {
      ipcMain.on(channel, listener as never)
    },

    unregisterListener(channel, listener) {
      ipcMain.removeListener(channel, listener as never)
    },
  }
}
