/**
 * runtime-env 单测 — 覆盖 PATH 注入与 Node 回退
 *
 * 重点是 Windows 上 PATH 键名大小写：process.env 里通常是 Path，
 * 若我们另写一个 PATH，子进程会拿到两个变量，行为不确定。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { delimiter, join } from 'node:path'
// lumii-ui shim 解析走 electron 的 app.isPackaged；测试里给个开发态替身
vi.mock('electron', () => ({ app: { isPackaged: false } }))
import { _resetWindowsClientDataRootCacheForTest } from './client-data-root'
import { PYPI_MIRROR, _resetSystemPythonCache } from './python-env'
import {
  _resetSystemNodeCache,
  buildScriptEnv,
  getShimDir,
  initScriptRuntimes,
  resolveElectronNodeExec,
  resolveNodeExec,
  shouldUseBundledPython,
} from './runtime-env'

/** 取 env 里所有 path 键（不分大小写） */
function pathKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((k) => /^path$/i.test(k))
}

describe('runtime-env', () => {
  // 预置成"系统既没有 node 也没有 python"，与开发机实际装了什么无关
  beforeEach(() => {
    _resetSystemNodeCache(null)
    _resetSystemPythonCache(null)
  })

  it('系统有 node 时 resolveNodeExec 优先系统 node', () => {
    _resetSystemNodeCache('node')
    const { command, env } = resolveNodeExec()
    expect(command).toBe('node')
    expect(env).toEqual({})
  })

  it('resolveElectronNodeExec 始终使用 Electron 内置 Node', () => {
    _resetSystemNodeCache('node')
    const { command, env } = resolveElectronNodeExec()
    expect(command).toBe(process.execPath)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('系统无 node 时回退 Electron 内置 Node', () => {
    const { command, env } = resolveNodeExec()
    expect(command).toBe(process.execPath)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('shim 目录追加到 PATH 末尾，且只有一个 PATH 键', () => {
    const env = buildScriptEnv()
    const keys = pathKeys(env)
    expect(keys).toHaveLength(1)
    expect(env[keys[0]].split(delimiter).pop()).toBe(getShimDir())
  })

  it('重复调用不会重复追加 shim 目录', () => {
    const once = buildScriptEnv()
    const key = pathKeys(once)[0]
    const twice = buildScriptEnv({ [key]: once[key] })
    const hits = twice[pathKeys(twice)[0]]
      .split(delimiter)
      .filter((p) => p === getShimDir())
    expect(hits).toHaveLength(1)
  })

  it('系统无 Python 时注入 pip 镜像，已有配置不覆盖', () => {
    expect(buildScriptEnv().PIP_INDEX_URL).toBe(PYPI_MIRROR)
    expect(buildScriptEnv({ PIP_INDEX_URL: 'https://my.mirror/simple' }).PIP_INDEX_URL)
      .toBe('https://my.mirror/simple')
  })

  it('默认注入 CLI_HUB_NO_ANALYTICS=1，已有值不覆盖', () => {
    expect(buildScriptEnv().CLI_HUB_NO_ANALYTICS).toBe('1')
    expect(buildScriptEnv({ CLI_HUB_NO_ANALYTICS: '0' }).CLI_HUB_NO_ANALYTICS).toBe('0')
  })
})

describe('python shim 平台策略（设计 D22）', () => {
  const tmpRoots: string[] = []

  afterEach(() => {
    delete process.env.LUMII_CLIENT_DATA_DIR
    delete process.env.LUMII_SKIP_PYTHON_BOOTSTRAP
    _resetWindowsClientDataRootCacheForTest()
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shouldUseBundledPython：仅 Windows 且系统无 Python 时', () => {
    expect(shouldUseBundledPython('win32', false)).toBe(true)
    expect(shouldUseBundledPython('win32', true)).toBe(false)
    expect(shouldUseBundledPython('linux', false)).toBe(false)
    expect(shouldUseBundledPython('darwin', false)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'Linux 不写 python shim，并清理历史坏 shim（指向 python.exe 的那种）',
    async () => {
      const root = mkdtempSync(join(os.tmpdir(), 'lumii-shim-test-'))
      tmpRoots.push(root)
      process.env.LUMII_CLIENT_DATA_DIR = root
      process.env.LUMII_SKIP_PYTHON_BOOTSTRAP = '1'
      _resetWindowsClientDataRootCacheForTest()
      // 模拟「系统无 python」——旧实现会在此写指向 python.exe 的坏 shim
      _resetSystemPythonCache(null)

      const binDir = join(root, 'runtimes', 'bin')
      mkdirSync(binDir, { recursive: true })
      writeFileSync(join(binDir, 'python'), '#!/bin/sh\n# stale shim')
      writeFileSync(join(binDir, 'python3.cmd'), '@echo off')

      await initScriptRuntimes()

      expect(existsSync(join(binDir, 'python'))).toBe(false)
      expect(existsSync(join(binDir, 'python3.cmd'))).toBe(false)
      // lumii-ui shim 照常写入（与 Python 无关的能力不受影响）
      expect(existsSync(join(binDir, 'lumii-ui'))).toBe(true)
    },
  )
})
