import { describe, expect, it } from 'vitest'

import { PYPI_MIRROR, BUNDLED_ONNXRUNTIME_SPEC, buildBundledPipInstallArgs } from './python-env'

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
