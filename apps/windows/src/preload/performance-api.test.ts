import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * preload/index.ts 在模块加载时会立刻执行一系列初始化（contextBridge.exposeInMainWorld、
 * ipcRenderer 监听注册等），无法像普通模块一样按需 import 后再断言。这里 mock 整个
 * electron 模块，捕获传给 contextBridge.exposeInMainWorld('electronAPI', ...) 的真实对象，
 * 从而验证 performance 这一小节的桥接确实按预期接到了对应的 ipcRenderer.invoke 通道，
 * 而不是像本计划最初的测试那样只断言一个手写的 mock 对象（那种写法测的是 mock 本身，不是实现）。
 */
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(async () => undefined), on: vi.fn(), removeListener: vi.fn() },
}))

describe('preload performance API bridge', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function loadExposedElectronApi() {
    const { contextBridge } = await import('electron')
    await import('./index')
    const calls = (contextBridge.exposeInMainWorld as ReturnType<typeof vi.fn>).mock.calls
    const call = calls.find(c => c[0] === 'electronAPI')
    return call![1] as { performance: Record<string, (...args: unknown[]) => unknown> }
  }

  it('should expose performance.getReport() wired to the performance:getReport channel', async () => {
    const electronAPI = await loadExposedElectronApi()
    const { ipcRenderer } = await import('electron')

    expect(electronAPI.performance.getReport).toBeDefined()
    await electronAPI.performance.getReport()
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('performance:getReport')
  })

  it('should expose performance.capture() wired to the performance:capture channel', async () => {
    const electronAPI = await loadExposedElectronApi()
    const { ipcRenderer } = await import('electron')

    expect(electronAPI.performance.capture).toBeDefined()
    await electronAPI.performance.capture()
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('performance:capture')
  })

  it('should expose performance.openLogFolder() wired to the performance:openLogFolder channel', async () => {
    const electronAPI = await loadExposedElectronApi()
    const { ipcRenderer } = await import('electron')

    expect(electronAPI.performance.openLogFolder).toBeDefined()
    await electronAPI.performance.openLogFolder()
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('performance:openLogFolder')
  })
})
