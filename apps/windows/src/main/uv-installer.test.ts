/**
 * uv / uvx 自动安装测试
 *
 * 安装执行走 `platform/shell-command`（mock 掉）；`resolveCommand` 与
 * `refreshCommonCliPathsInProcessEnv` 也 mock，覆盖状态机与降级逻辑。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockResolveCommand = vi.fn()
const mockRefreshPath = vi.fn()
const mockRunShellCommand = vi.fn()
const mockVenvReady = vi.fn(() => false)

vi.mock('@mtbot/agent-runtime', () => ({
  resolveCommand: (...args: unknown[]) => mockResolveCommand(...args),
}))

vi.mock('./cli-user-path.js', () => ({
  refreshCommonCliPathsInProcessEnv: () => mockRefreshPath(),
}))

vi.mock('./platform/shell-command.js', () => ({
  runShellCommand: (...args: unknown[]) => mockRunShellCommand(...args),
}))

vi.mock('./python-venv.js', () => ({
  isPythonVenvReady: () => mockVenvReady(),
  getPythonVenvExe: () => '/home/x/.lumii/runtimes/python-venv/bin/python',
}))

import { __resetUvInstallerStateForTests, ensureUvxInstalled, isUvxAvailable } from './uv-installer.js'

function mockUvxFound(found: boolean): void {
  mockResolveCommand.mockReturnValue(
    found
      ? { command: '/home/x/.local/bin/uvx', prefixArgs: [] }
      : { command: 'uvx', prefixArgs: [] },
  )
}

/** 官方脚本退出码 + 后续探测结果序列 */
function mockShell(exitCode: number | null, stderr = ''): void {
  mockRunShellCommand.mockResolvedValue({ exitCode, stdout: '', stderr })
}

const isWin = process.platform === 'win32'

describe('uv-installer', () => {
  beforeEach(() => {
    // reset（非 clear）：清掉上一次用例遗留的 mockResolvedValueOnce 队列
    vi.resetAllMocks()
    mockRefreshPath.mockImplementation(() => {})
    mockResolveCommand.mockReturnValue({ command: 'uvx', prefixArgs: [] })
    mockVenvReady.mockReturnValue(false)
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
    expect(mockRunShellCommand).not.toHaveBeenCalled()
  })

  it('缺失时执行官方安装脚本（命令按平台），成功后返回已安装', async () => {
    let calls = 0
    mockResolveCommand.mockImplementation(() => {
      calls += 1
      return calls === 1 ? { command: 'uvx', prefixArgs: [] } : { command: '/home/x/.local/bin/uvx', prefixArgs: [] }
    })
    mockShell(0)

    const result = await ensureUvxInstalled()

    expect(result.ok).toBe(true)
    expect(result.installed).toBe(true)
    const command = String(mockRunShellCommand.mock.calls[0]?.[0])
    if (isWin) {
      expect(command).toContain('astral.sh/uv/install.ps1')
    } else {
      expect(command).toContain('astral.sh/uv/install.sh')
    }
  })

  it('安装后仍找不到 uvx 时返回失败，给出手动安装链接', async () => {
    mockUvxFound(false)
    mockShell(1)

    const result = await ensureUvxInstalled()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/uv/)
    expect(result.message).toContain('https://docs.astral.sh/uv/')
  })

  it.skipIf(isWin)('Linux：官方脚本失败且 venv 未就绪时，不尝试 pip 兜底', async () => {
    mockUvxFound(false)
    mockVenvReady.mockReturnValue(false)
    mockShell(1)

    await ensureUvxInstalled()

    expect(mockRunShellCommand).toHaveBeenCalledTimes(1)
  })

  it.skipIf(isWin)('Linux：官方脚本失败、venv 就绪时用 venv pip 兜底并成功', async () => {
    // 探测时序：入口一次 + 脚本后一次都找不到；pip 之后再查才命中
    let calls = 0
    mockResolveCommand.mockImplementation(() => {
      calls += 1
      return calls <= 2
        ? { command: 'uvx', prefixArgs: [] }
        : { command: '/home/x/.lumii/runtimes/python-venv/bin/uvx', prefixArgs: [] }
    })
    mockVenvReady.mockReturnValue(true)
    mockRunShellCommand
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'github unreachable' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Successfully installed uv', stderr: '' })

    const result = await ensureUvxInstalled()

    expect(result.ok).toBe(true)
    expect(result.message).toContain('venv')
    const pipCommand = String(mockRunShellCommand.mock.calls[1]?.[0])
    expect(pipCommand).toContain('-m pip install uv')
  })

  it.skipIf(isWin)('Linux：两条路都失败时把两个退出码都带进消息', async () => {
    mockUvxFound(false)
    mockVenvReady.mockReturnValue(true)
    mockRunShellCommand
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'github unreachable' })
      .mockResolvedValueOnce({ exitCode: 2, stdout: '', stderr: 'no matching distribution' })

    const result = await ensureUvxInstalled()

    expect(result.ok).toBe(false)
    expect(result.message).toContain('no matching distribution')
    expect(result.message).toMatch(/exit=1/)
    expect(result.message).toMatch(/exit=2/)
  })
})
