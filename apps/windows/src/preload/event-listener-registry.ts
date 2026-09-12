/**
 * 通用 IPC 事件监听注册表
 *
 * `electronAPI.on` 给回调包了一层剥离 `IpcRendererEvent` 的 listener，
 * 而 `off` 若直接按原回调 removeListener 会移除失败（注册的是包装函数），
 * 导致取消订阅不生效、监听持续泄漏。此处保存「channel + 回调 → 包装 listener」
 * 的注册记录，供 off 精确移除。
 */

/** 注册表依赖的最小 ipcRenderer 面（单测注入 mock） */
export interface IpcListenerHost {
  on(channel: string, listener: (...args: unknown[]) => void): void
  removeListener(channel: string, listener: (...args: unknown[]) => void): void
}

interface Registration {
  channel: string
  callback: (...args: unknown[]) => void
  listener: (...args: unknown[]) => void
}

export interface EventListenerRegistry {
  /** 订阅 channel；回调只收业务参数（事件对象被剥离） */
  on(channel: string, callback: (...args: unknown[]) => void): void
  /** 取消订阅；与 removeListener 语义一致，移除最近一次注册的匹配项 */
  off(channel: string, callback: (...args: unknown[]) => void): void
}

/** 创建事件监听注册表 */
export function createEventListenerRegistry(ipc: IpcListenerHost): EventListenerRegistry {
  const registrations: Registration[] = []

  return {
    on(channel, callback) {
      const listener = (...allArgs: unknown[]) => callback(...allArgs.slice(1))
      registrations.push({ channel, callback, listener })
      ipc.on(channel, listener)
    },

    off(channel, callback) {
      for (let i = registrations.length - 1; i >= 0; i -= 1) {
        const registration = registrations[i]
        if (registration.channel === channel && registration.callback === callback) {
          registrations.splice(i, 1)
          ipc.removeListener(channel, registration.listener)
          return
        }
      }
    },
  }
}
