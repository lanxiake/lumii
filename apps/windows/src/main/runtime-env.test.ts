/**
 * runtime-env 单测 — 覆盖 PATH 注入与 Node 回退
 *
 * 重点是 Windows 上 PATH 键名大小写：process.env 里通常是 Path，
 * 若我们另写一个 PATH，子进程会拿到两个变量，行为不确定。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { delimiter } from 'node:path'
import { PYPI_MIRROR, _resetSystemPythonCache } from './python-env'
import {
  _resetSystemNodeCache,
  buildScriptEnv,
  getShimDir,
  resolveNodeExec,
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
