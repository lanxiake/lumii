/** @vitest-environment node */
/**
 * python-venv 单测：创建引导两条路径、版本门槛、就绪探测与失败清理。
 *
 * 走真实文件系统（数据根指向临时目录），只 mock 子进程与网络下载。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cpMock = vi.hoisted(() => ({ execSync: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', () => cpMock)
vi.mock('./download-file', () => ({
  // 落一个真实占位文件，让后续的 fs.unlink 与真实流程一致
  downloadFile: vi.fn(async (_url: string, dest: string) => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(dest, 'placeholder')
  }),
}))

import { _resetWindowsClientDataRootCacheForTest } from './client-data-root'
import { downloadFile } from './download-file'
import { _resetSystemPythonCache } from './python-env'
import {
  _resetPythonVenvCache,
  ensurePythonVenv,
  getPythonVenvDir,
  getPythonVenvExe,
  isPythonVenvReady,
  meetsVenvRequirement,
} from './python-venv'

/** promisify 后的 execFile 走回调约定（cmd, args, opts, cb） */
function execFileSucceeds(): void {
  cpMock.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out?: unknown) => void) => {
      cb(null, { stdout: '', stderr: '' })
    },
  )
}

let tmpRoot: string

describe('python-venv', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(os.tmpdir(), 'lumii-venv-test-'))
    process.env.LUMII_CLIENT_DATA_DIR = tmpRoot
    _resetWindowsClientDataRootCacheForTest()
    _resetPythonVenvCache()
    _resetSystemPythonCache('python3', [3, 12, 3])
    cpMock.execFile.mockReset()
    cpMock.execSync.mockReset()
    vi.mocked(downloadFile).mockClear()
    execFileSucceeds()
  })

  afterEach(() => {
    delete process.env.LUMII_CLIENT_DATA_DIR
    _resetWindowsClientDataRootCacheForTest()
    _resetPythonVenvCache()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('meetsVenvRequirement：3.10 起，3.9 拒绝', () => {
    expect(meetsVenvRequirement([3, 9, 18])).toBe(false)
    expect(meetsVenvRequirement([3, 10, 0])).toBe(true)
    expect(meetsVenvRequirement([3, 12, 3])).toBe(true)
    expect(meetsVenvRequirement([4, 0, 0])).toBe(true)
  })

  it('一步路径：python3 -m venv 成功，不下载 get-pip.py，产物落位', async () => {
    const exe = await ensurePythonVenv()

    expect(cpMock.execFile.mock.calls[0]?.[0]).toBe('python3')
    expect(cpMock.execFile.mock.calls[0]?.[1]).toEqual(['-m', 'venv', `${getPythonVenvDir()}.tmp`])
    expect(vi.mocked(downloadFile)).not.toHaveBeenCalled()
    expect(existsSync(getPythonVenvDir())).toBe(true)
    expect(exe).toBe(getPythonVenvExe())
    // 就绪探测也随之为真（无需起进程：缓存已置）
    expect(isPythonVenvReady()).toBe(true)
  })

  it('回退路径：venv 失败 → --without-pip + get-pip.py 补 pip', async () => {
    let venvCalls = 0
    cpMock.execFile.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, out?: unknown) => void) => {
        if (args.includes('-m') && args.includes('venv')) {
          venvCalls += 1
          if (venvCalls === 1) {
            cb(new Error('ensurepip is not available'))
            return
          }
        }
        cb(null, { stdout: '', stderr: '' })
      },
    )

    await ensurePythonVenv()

    expect(venvCalls).toBe(2)
    const secondArgs = cpMock.execFile.mock.calls[1]?.[1] as string[]
    expect(secondArgs).toContain('--without-pip')
    expect(vi.mocked(downloadFile)).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(downloadFile).mock.calls[0]?.[0])).toContain('get-pip.py')
    // get-pip.py 是用 venv 里的 python 执行的
    const getPipCall = cpMock.execFile.mock.calls.find((c) =>
      (c[1] as string[])?.some((a) => a.endsWith('get-pip.py')),
    )
    expect(getPipCall).toBeTruthy()
    expect(existsSync(getPythonVenvDir())).toBe(true)
  })

  it('系统无 Python：拒绝并给安装指引', async () => {
    _resetSystemPythonCache(null)
    await expect(ensurePythonVenv()).rejects.toThrow(/Python 3.*安装|安装.*Python 3|sudo apt install python3/s)
    expect(existsSync(getPythonVenvDir())).toBe(false)
  })

  it('系统 Python 版本过低：拒绝并说明下限', async () => {
    _resetSystemPythonCache('python3', [3, 9, 18])
    await expect(ensurePythonVenv()).rejects.toThrow(/3\.9\.18.*过低|过低.*3\.10/)
  })

  it('pip 校验失败：清理 .tmp，不产生半装目录', async () => {
    cpMock.execFile.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, out?: unknown) => void) => {
        if (args.includes('--version')) {
          cb(new Error('No module named pip'))
          return
        }
        cb(null, { stdout: '', stderr: '' })
      },
    )

    await expect(ensurePythonVenv()).rejects.toThrow(/pip/)
    expect(existsSync(getPythonVenvDir())).toBe(false)
    expect(existsSync(`${getPythonVenvDir()}.tmp`)).toBe(false)
  })

  it('isPythonVenvReady：venv 缺失时为假且不调用 execSync', () => {
    expect(isPythonVenvReady()).toBe(false)
    expect(cpMock.execSync).not.toHaveBeenCalled()
  })
})
