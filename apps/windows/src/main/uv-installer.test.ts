/**
 * uv / uvx 自动安装测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockResolveCommand = vi.fn()
const mockSpawn = vi.fn()
const mockRefreshPath = vi.fn()

vi.mock('@mtbot/agent-runtime', () => ({
  resolveCommand: (...args: unknown[]) => mockResolveCommand(...args),
}))

vi.mock('./cli-user-path.js', () => ({
  refreshCommonCliPathsInProcessEnv: () => mockRefreshPath(),
}))

import {
  __resetUvInstallerStateForTests,
  __setUvSpawnForTests,
  ensureUvxInstalled,
  isUvxAvailable,
} from './uv-installer.js'

/** 模拟 PowerShell 安装子进程 */
function mockInstallChild(exitCode: number): void {
  mockSpawn.mockImplementation(() => {
    const handlers: Record<string, Array<(arg?: unknown) => void>> = {}
    const child = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, fn: (arg?: unknown) => void) => {
        handlers[event] = handlers[event] ?? []
        handlers[event].push(fn)
      }),
      kill: vi.fn(),
    }
    queueMicrotask(() => {
      for (const fn of handlers.close ?? []) fn(exitCode)
    })
    return child
  })
  __setUvSpawnForTests(mockSpawn as never)
}

function mockUvxFound(found: boolean): void {
  mockResolveCommand.mockReturnValue(
    found
      ? { command: 'C:\\Users\\x\\.local\\bin\\uvx.exe', prefixArgs: [] }
      : { command: 'uvx', prefixArgs: [] },
  )
}

describe('uv-installer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRefreshPath.mockImplementation(() => {})
    __resetUvInstallerStateForTests()
  })

  it('isUvxAvailable 在 resolveCommand 返回绝对路径时为 true', () => {
    mockUvxFound(true)
    expect(isUvxAvailable()).toBe(true)
  })

  it('isUvxAvailable 在找不到 uvx 时为 false', () => {
    mockUvxFound(false)
    expect(isUvxAvailable()).toBe(false)
  })

  it('ensureUvxInstalled 已有时不跑安装脚本', async () => {
    mockUvxFound(true)
    const result = await ensureUvxInstalled()
    expect(result.ok).toBe(true)
    expect(result.installed).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('ensureUvxInstalled 缺失时执行官方脚本并在成功后返回', async () => {
    let calls = 0
    mockResolveCommand.mockImplementation(() => {
      calls += 1
      return calls === 1
        ? { command: 'uvx', prefixArgs: [] }
        : { command: 'C:\\Users\\x\\.local\\bin\\uvx.exe', prefixArgs: [] }
    })
    mockInstallChild(0)

    const result = await ensureUvxInstalled()
    expect(result.ok).toBe(true)
    expect(result.installed).toBe(true)
    expect(mockSpawn).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-ExecutionPolicy', 'Bypass']),
      expect.any(Object),
    )
  })

  it('ensureUvxInstalled 安装后仍找不到 uvx 时返回失败', async () => {
    mockUvxFound(false)
    mockInstallChild(1)

    const result = await ensureUvxInstalled()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/uv/)
  })
})
