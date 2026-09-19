/**
 * @vitest-environment node
 */
/**
 * 托盘引导的容错规格（设计 §6.1）。
 *
 * 核心风险：**Linux 上托盘不保证可用**（GNOME 默认不带 StatusNotifierItem 支持），
 * 而 `index.ts` 在启动序列里裸调 `initializeTray()`——异常一旦冒泡，后面的
 * `initSystemService` / `initScreenRecordService` / 云同步全都起不来。
 * 托盘只是可选入口，不该拖垮启动。
 *
 * 用 mock 的 electron 模块触发 `new Tray()` 抛异常来验证降级路径。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { trayCtorSpy, loggerSpy } = vi.hoisted(() => ({
  trayCtorSpy: vi.fn(),
  loggerSpy: { info: vi.fn(), warn: vi.fn() },
}))

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  Tray: class {
    constructor(...args: unknown[]) {
      trayCtorSpy(...args)
      const impl = trayCtorSpy.getMockImplementation()
      if (impl) impl(...args)
    }
    setToolTip(): void {}
    setContextMenu(): void {}
    on(): void {}
    destroy(): void {}
    displayBalloon(): void {}
  },
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => false, getSize: () => ({ width: 32, height: 32 }), resize: (o: unknown) => o }),
  },
  BrowserWindow: class {},
}))

vi.mock('../pet/pet-mode-ipc', () => ({
  isPetMode: () => false,
  switchPetMode: vi.fn(),
  isPetForceIgnore: () => false,
  disablePetForceIgnore: vi.fn(),
}))

vi.mock('../tray-icon', () => ({ getTrayIconPath: () => '/tmp/icon.png' }))

import { initializeTray } from './tray-bootstrap'

function options() {
  return {
    logger: loggerSpy,
    getMainWindow: () => null,
    getScreenRecordService: () => null,
    setTrayManager: vi.fn(),
    setQuitting: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  trayCtorSpy.mockImplementation(() => {})
})

describe('initializeTray — 容错', () => {
  it('正常时返回 true 并注册 manager', () => {
    const opts = options()

    const ok = initializeTray(opts as never)

    expect(ok).toBe(true)
    expect(opts.setTrayManager).toHaveBeenCalledTimes(1)
  })

  it('托盘创建失败时不抛异常，返回 false（启动流程必须继续）', () => {
    trayCtorSpy.mockImplementation(() => {
      throw new Error('StatusNotifierItem is not supported')
    })

    expect(() => initializeTray(options() as never)).not.toThrow()
    expect(initializeTray(options() as never)).toBe(false)
  })

  it('失败时记 warn（不静默吞掉，D4）', () => {
    trayCtorSpy.mockImplementation(() => {
      throw new Error('tray unavailable')
    })

    initializeTray(options() as never)

    expect(loggerSpy.warn).toHaveBeenCalled()
    const msg = String(loggerSpy.warn.mock.calls[0]![0])
    expect(msg).toContain('tray unavailable')
  })

  it('失败时不注册 manager（避免调用方拿到半初始化的托盘）', () => {
    trayCtorSpy.mockImplementation(() => {
      throw new Error('boom')
    })
    const opts = options()

    initializeTray(opts as never)

    expect(opts.setTrayManager).not.toHaveBeenCalled()
  })

  it('Linux 上额外给出可操作的提示（装 AppIndicator 扩展）', () => {
    if (process.platform !== 'linux') return
    trayCtorSpy.mockImplementation(() => {
      throw new Error('boom')
    })

    initializeTray(options() as never)

    const all = loggerSpy.warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(all).toContain('AppIndicator')
  })

  it('非 Error 抛出物（字符串/对象）也能被处理', () => {
    trayCtorSpy.mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain string error'
    })

    expect(() => initializeTray(options() as never)).not.toThrow()
    expect(loggerSpy.warn).toHaveBeenCalled()
  })
})
