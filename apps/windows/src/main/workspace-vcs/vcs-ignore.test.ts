import { describe, expect, it } from 'vitest'
import {
  isVcsBinaryPath,
  stripOutputsIgnoreRules,
} from './vcs-ignore'

describe('vcs-ignore', () => {
  it('stripOutputsIgnoreRules 移除目录级 outputs 忽略', () => {
    const input = [
      'node_modules/',
      'outputs/',
      'outputs',
      '/outputs/',
      'outputs/**',
      'uploads/**/*.pdf',
      '',
    ].join('\n')
    const out = stripOutputsIgnoreRules(input)
    expect(out).not.toMatch(/(^|\n)\/?outputs/)
    expect(out).toContain('node_modules/')
    expect(out).toContain('uploads/**/*.pdf')
  })

  it('isVcsBinaryPath 识别 pdf/图片等', () => {
    expect(isVcsBinaryPath('outputs/合并.pdf')).toBe(true)
    expect(isVcsBinaryPath('outputs/a/b.png')).toBe(true)
    expect(isVcsBinaryPath('SOUL.md')).toBe(false)
    expect(isVcsBinaryPath('skills/foo.ts')).toBe(false)
  })
})
