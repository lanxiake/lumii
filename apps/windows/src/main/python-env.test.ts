/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cpMock = vi.hoisted(() => ({ execSync: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', () => cpMock)

import {
  PYPI_MIRROR,
  BUNDLED_ONNXRUNTIME_SPEC,
  buildBundledPipInstallArgs,
  detectSystemPython,
  detectSystemPythonInfo,
  _resetSystemPythonCache,
} from './python-env'

describe('buildBundledPipInstallArgs', () => {
  it('安装到内置 site-packages，不使用 --target', () => {
    const args = buildBundledPipInstallArgs(['faster-qwen3-tts'])
    expect(args).toEqual([
      '-m', 'pip', 'install',
      'faster-qwen3-tts',
      '--no-warn-script-location',
      '-i', PYPI_MIRROR,
    ])
    expect(args).not.toContain('--target')
  })

  it('可钉死特定版本（Win10 只认 onnxruntime 1.20.1）', () => {
    const args = buildBundledPipInstallArgs(['faster-qwen3-tts', BUNDLED_ONNXRUNTIME_SPEC])
    expect(args).toContain('faster-qwen3-tts')
    expect(args).toContain('onnxruntime==1.20.1')
    expect(args).not.toContain('--target')
  })

  it('允许追加 force-reinstall 等参数且仍不含 --target', () => {
    const args = buildBundledPipInstallArgs(
      ['transformers'],
      ['--force-reinstall', '--no-deps'],
    )
    expect(args).toContain('--force-reinstall')
    expect(args).toContain('--no-deps')
    expect(args).not.toContain('--target')
  })
})

describe('detectSystemPythonInfo', () => {
  beforeEach(() => {
    _resetSystemPythonCache()
    cpMock.execSync.mockReset()
  })

  it('python3 可用时返回命令与版本', () => {
    cpMock.execSync.mockReturnValue('Python 3.12.3\n')
    expect(detectSystemPythonInfo()).toEqual({ command: 'python3', version: [3, 12, 3] })
    expect(detectSystemPython()).toBe('python3')
    expect(String(cpMock.execSync.mock.calls[0]?.[0])).toContain('python3 --version')
  })

  it('python3 失败时退回 python', () => {
    cpMock.execSync.mockImplementation((cmd: string) => {
      if (String(cmd).startsWith('python3')) throw new Error('not found')
      return 'Python 3.11.9'
    })
    expect(detectSystemPythonInfo()).toEqual({ command: 'python', version: [3, 11, 9] })
  })

  it('非 Python 3 输出不采用', () => {
    cpMock.execSync.mockReturnValue('Python 2.7.18')
    expect(detectSystemPythonInfo()).toBeNull()
  })

  it('全失败返回 null，且负结果在 30s 内命中缓存、之后重探', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      cpMock.execSync.mockImplementation(() => {
        throw new Error('not found')
      })
      expect(detectSystemPythonInfo()).toBeNull()
      const callsAfterFirstProbe = cpMock.execSync.mock.calls.length
      expect(callsAfterFirstProbe).toBeGreaterThan(0)

      // TTL 内：不重复起进程
      expect(detectSystemPythonInfo()).toBeNull()
      expect(cpMock.execSync.mock.calls.length).toBe(callsAfterFirstProbe)

      // 超过 TTL：重探（模拟用户中途装上 python3，不必重启应用）
      vi.setSystemTime(Date.now() + 31_000)
      cpMock.execSync.mockReturnValue('Python 3.12.3')
      expect(detectSystemPython()?.startsWith('python')).toBe(true)
      expect(cpMock.execSync.mock.calls.length).toBeGreaterThan(callsAfterFirstProbe)
    } finally {
      vi.useRealTimers()
    }
  })

  it('测试钩子可预置命令与版本（不触发探测）', () => {
    _resetSystemPythonCache('py', [3, 11, 9])
    expect(detectSystemPythonInfo()).toEqual({ command: 'py', version: [3, 11, 9] })
    expect(cpMock.execSync).not.toHaveBeenCalled()
  })
})
