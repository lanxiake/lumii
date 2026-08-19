import { describe, expect, it } from 'vitest'

import {
  PYPI_MIRROR,
  buildBundledPipInstallArgs,
  needsGoogleRpcRepair,
} from './python-env'

describe('buildBundledPipInstallArgs', () => {
  it('安装到内置 site-packages，不使用 --target', () => {
    const args = buildBundledPipInstallArgs(['mempalace'])
    expect(args).toEqual([
      '-m', 'pip', 'install',
      'mempalace',
      '--no-warn-script-location',
      '-i', PYPI_MIRROR,
    ])
    expect(args).not.toContain('--target')
  })

  it('允许追加 force-reinstall 等参数且仍不含 --target', () => {
    const args = buildBundledPipInstallArgs(
      ['googleapis-common-protos'],
      ['--force-reinstall', '--no-deps'],
    )
    expect(args).toContain('--force-reinstall')
    expect(args).toContain('--no-deps')
    expect(args).not.toContain('--target')
  })
})

describe('needsGoogleRpcRepair', () => {
  it('google.rpc 已存在则不修复', () => {
    expect(needsGoogleRpcRepair({
      googleRpcExists: true,
      hasChromadb: true,
      hasGoogleapisCommonProtos: true,
    })).toBe(false)
  })

  it('chroma 在场但 google.rpc 缺失则需要修复', () => {
    expect(needsGoogleRpcRepair({
      googleRpcExists: false,
      hasChromadb: true,
      hasGoogleapisCommonProtos: false,
    })).toBe(true)
  })

  it('仅有 googleapis-common-protos 元数据、文件丢失时也要修复', () => {
    expect(needsGoogleRpcRepair({
      googleRpcExists: false,
      hasChromadb: false,
      hasGoogleapisCommonProtos: true,
    })).toBe(true)
  })

  it('无关环境不修复', () => {
    expect(needsGoogleRpcRepair({
      googleRpcExists: false,
      hasChromadb: false,
      hasGoogleapisCommonProtos: false,
    })).toBe(false)
  })
})
