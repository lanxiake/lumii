/**
 * Vitest 测试环境设置
 */

import '@testing-library/jest-dom'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeAll, vi } from 'vitest'

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
