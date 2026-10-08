/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
  detectSystemPythonInfo: vi.fn(),
  ensureBundledPython: vi.fn(),
  ensurePythonVenv: vi.fn(),
}))

vi.mock('node:child_process', () => ({ execSync: mocks.execSync, execFile: mocks.execFile }))
vi.mock('./python-env', () => ({
  buildBundledPipInstallArgs: (pkgs: string[]) => ['-m', 'pip', 'install', ...pkgs],
  detectSystemPythonInfo: mocks.detectSystemPythonInfo,
  ensureBundledPython: mocks.ensureBundledPython,
  getBundledPythonExe: () => '/managed/python-embed/python.exe',
}))
vi.mock('./python-venv', () => ({
  ensurePythonVenv: mocks.ensurePythonVenv,
  getPythonVenvExe: () => '/managed/python-venv/bin/python',
}))

import {
  _resetMcpPythonCache,
  classifyPythonCommand,
  resolveMcpPython,
} from './mcp-python'

const MANAGED = '/managed/python'
const PACKAGES = [
  { spec: 'pycryptodome>=3.20', module: 'Crypto' },
  { spec: 'zstandard>=0.22', module: 'zstandard' },
]

/** 让 promisify(execFile) 按调用依次返回 stdout */
function execFileReturns(...stdouts: string[]): void {
  for (const stdout of stdouts) {
    mocks.execFile.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (err: Error | null, out: { stdout: string; stderr: string }) => void
      callback(null, { stdout, stderr: '' })
    })
  }
}

describe('classifyPythonCommand', () => {
  it('区分托管占位符、裸 python 与其他命令', () => {
    expect(classifyPythonCommand('{{LUMII_PYTHON}}')).toBe('managed')
    for (const bare of ['python', 'python3', 'Python.exe', ' python3.exe ']) {
      expect(classifyPythonCommand(bare), bare).toBe('bare')
    }
    for (const other of ['npx', 'uvx', 'C:/Python311/python.exe', 'pythonw']) {
      expect(classifyPythonCommand(other), other).toBeNull()
    }
  })
})

describe('resolveMcpPython', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetMcpPythonCache()
    mocks.ensureBundledPython.mockResolvedValue(MANAGED)
    mocks.ensurePythonVenv.mockResolvedValue(MANAGED)
  })

  it('非 Python 命令原样返回，不探测任何解释器', async () => {
    await expect(resolveMcpPython('npx')).resolves.toEqual({ ok: true, command: 'npx' })
    expect(mocks.detectSystemPythonInfo).not.toHaveBeenCalled()
  })

  it('裸 python：解析为系统解释器的绝对路径（不再交给 PATH 去撞 Store 占位程序）', async () => {
    mocks.detectSystemPythonInfo.mockReturnValue({ command: 'python', version: [3, 12, 1] })
    mocks.execSync.mockReturnValue('C:\\Python312\\python.exe\r\n')

    await expect(resolveMcpPython('python')).resolves.toEqual({
      ok: true,
      command: 'C:\\Python312\\python.exe',
    })
    expect(mocks.execSync).toHaveBeenCalledTimes(1)
    expect(mocks.ensureBundledPython).not.toHaveBeenCalled()
    expect(mocks.ensurePythonVenv).not.toHaveBeenCalled()
  })

  it('裸 python 且系统没有可用 Python：退回托管解释器，且不往里装包', async () => {
    mocks.detectSystemPythonInfo.mockReturnValue(null)

    await expect(resolveMcpPython('python', PACKAGES)).resolves.toEqual({ ok: true, command: MANAGED })
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('托管占位符：缺依赖时用 pip 补齐', async () => {
    execFileReturns('Crypto,zstandard\n', '')

    await expect(resolveMcpPython('{{LUMII_PYTHON}}', PACKAGES)).resolves.toEqual({
      ok: true,
      command: MANAGED,
    })
    expect(mocks.execFile).toHaveBeenCalledTimes(2)
    const [pipExe, pipArgs] = mocks.execFile.mock.calls[1] as [string, string[]]
    expect(pipExe).toBe(MANAGED)
    expect(pipArgs).toEqual(['-m', 'pip', 'install', 'pycryptodome>=3.20', 'zstandard>=0.22'])
  })

  it('托管占位符：依赖已齐时不调用 pip', async () => {
    execFileReturns('\n')

    await expect(resolveMcpPython('{{LUMII_PYTHON}}', PACKAGES)).resolves.toEqual({
      ok: true,
      command: MANAGED,
    })
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
  })

  it('依赖安装失败不阻断连接，只返回告警', async () => {
    execFileReturns('Crypto\n')
    mocks.execFile.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (err: Error | null) => void
      callback(new Error('network down'))
    })

    const result = await resolveMcpPython('{{LUMII_PYTHON}}', PACKAGES)
    expect(result).toMatchObject({ ok: true, command: MANAGED })
    expect(result.ok && result.warning).toContain('network down')
  })

  it('托管解释器准备失败：返回可展示的错误', async () => {
    mocks.ensureBundledPython.mockRejectedValue(new Error('下载失败'))
    mocks.ensurePythonVenv.mockRejectedValue(new Error('下载失败'))

    const result = await resolveMcpPython('{{LUMII_PYTHON}}', PACKAGES)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('下载失败')
  })
})
