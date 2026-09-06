/**
 * Vitest 测试环境设置
 */

import '@testing-library/jest-dom'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeAll, vi } from 'vitest'

// lottie-web 等库在模块加载时创建 canvas 并调用 getContext('2d')，jsdom 未装 canvas 包会抛错。
// 必须在模块导入前（顶层）提供 2d 上下文 stub，让 SVG 渲染路径的库能在 jsdom 里加载。
if (typeof HTMLCanvasElement !== 'undefined') {
  const ctxStub = {
    fillStyle: '',
    strokeStyle: '',
    fillRect: () => {},
    strokeRect: () => {},
    clearRect: () => {},
    getImageData: () => ({ data: [] }),
    putImageData: () => {},
    createImageData: () => [],
    setTransform: () => {},
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    scale: () => {},
    translate: () => {},
    rotate: () => {},
    measureText: () => ({ width: 0 }),
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    clip: () => {},
  } as unknown as CanvasRenderingContext2D

  // getContext 是重载方法，用 any 断言绕过签名匹配（测试专用 stub）
  ;(HTMLCanvasElement.prototype as unknown as { getContext: () => CanvasRenderingContext2D }).getContext =
    function () {
      return ctxStub
    }
}

// 每个测试后清理
afterEach(() => {
  cleanup()
})

// 全局Mock
beforeAll(() => {
  // Mock window.electronAPI
  global.window = global.window || ({} as any)
  global.window.electronAPI = {
    on: vi.fn(),
    off: vi.fn(),
    invoke: vi.fn(),
    skills: {
      listLocalInstalled: vi.fn().mockResolvedValue([]),
    },
    system: {
      getUserPaths: vi.fn().mockResolvedValue({
        home: '',
        desktop: '',
        documents: '',
        downloads: '',
      }),
    },
  } as any

  // Mock console methods to reduce test noise
  global.console = {
    ...console,
    error: vi.fn(),
    warn: vi.fn(),
  }

  // Mock navigator.clipboard
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(''),
    },
  })

  // Mock localStorage
  const localStorageMock = (() => {
    let store: Record<string, string> = {}
    return {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => {
        store[key] = value
      },
      removeItem: (key: string) => {
        delete store[key]
      },
      clear: () => {
        store = {}
      },
    }
  })()

  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    writable: true,
  })

  // Mock window.confirm
  global.confirm = vi.fn(() => true)
  global.alert = vi.fn()
  global.prompt = vi.fn(() => 'test')
})
