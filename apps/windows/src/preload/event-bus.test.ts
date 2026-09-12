import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * electronAPI.on/off 取消订阅回归测试。
 *
 * 历史缺陷：on 注册的是剥离 IpcRendererEvent 的包装 listener，而 off 直接按
 * 原始回调 removeListener —— 移除失败，取消订阅不生效（监听泄漏）。
 * 这里 mock electron、捕获 contextBridge 暴露的真实 electronAPI，模拟主进程
 * 发事件并断言 off 后不再回调。
 */
const ipc = vi.hoisted(() => ({
  listeners: new Map<string, Array<(...args: unknown[]) => void>>(),
  removeListenerCalls: [] as Array<[string, (...args: unknown[]) => void]>,
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(async () => undefined),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const arr = ipc.listeners.get(channel) ?? []
      arr.push(listener)
      ipc.listeners.set(channel, arr)
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      ipc.removeListenerCalls.push([channel, listener])
      const arr = ipc.listeners.get(channel)
      if (!arr) return
      const idx = arr.lastIndexOf(listener)
      if (idx >= 0) arr.splice(idx, 1)
    },
  },
}))

/** 模拟主进程发事件；首参为渲染侧的 IpcRendererEvent */
function emit(channel: string, ...args: unknown[]) {
  for (const listener of [...(ipc.listeners.get(channel) ?? [])]) {
    listener({}, ...args)
  }
}

describe('electronAPI.on/off 取消订阅', () => {
  beforeEach(() => {
    ipc.listeners.clear()
    ipc.removeListenerCalls.length = 0
    vi.resetModules()
  })

  async function loadExposedElectronApi() {
    const { contextBridge } = await import('electron')
    await import('./index')
    const calls = (contextBridge.exposeInMainWorld as ReturnType<typeof vi.fn>).mock.calls
    const call = calls.find((c) => c[0] === 'electronAPI')
    return call![1] as {
      on: (channel: string, cb: (...args: unknown[]) => void) => void
      off: (channel: string, cb: (...args: unknown[]) => void) => void
    }
  }

  it('回调收到业务参数（事件对象被剥离）', async () => {
    const api = await loadExposedElectronApi()
    const cb = vi.fn()
    api.on('demo:event', cb)
    emit('demo:event', 'payload-a', 'payload-b')
    expect(cb).toHaveBeenCalledWith('payload-a', 'payload-b')
  })

  it('off 后回调不再收到事件，且移除的是 on 注册的包装 listener', async () => {
    const api = await loadExposedElectronApi()
    const cb = vi.fn()
    api.on('demo:event', cb)
    const registered = (ipc.listeners.get('demo:event') ?? [])[0]
    expect(registered).toBeDefined()
    expect(registered).not.toBe(cb)

    emit('demo:event', 'before-off')
    expect(cb).toHaveBeenCalledTimes(1)

    api.off('demo:event', cb)
    expect(ipc.removeListenerCalls).toContainEqual(['demo:event', registered])
    expect(ipc.listeners.get('demo:event') ?? []).toHaveLength(0)

    emit('demo:event', 'after-off')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('同一回调注册两次时，一次 off 只移除最近一次注册', async () => {
    const api = await loadExposedElectronApi()
    const cb = vi.fn()
    api.on('demo:event', cb)
    api.on('demo:event', cb)

    api.off('demo:event', cb)
    emit('demo:event', 'once')
    expect(cb).toHaveBeenCalledTimes(1)

    api.off('demo:event', cb)
    emit('demo:event', 'twice')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('off 未注册过的回调为安全无操作', async () => {
    const api = await loadExposedElectronApi()
    const cb = vi.fn()
    expect(() => api.off('demo:event', cb)).not.toThrow()
    expect(ipc.removeListenerCalls).toHaveLength(0)
  })
})
