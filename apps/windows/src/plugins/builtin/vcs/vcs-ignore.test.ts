import { describe, expect, it } from 'vitest'
import {
  isVcsBinaryPath,
  shouldSkipWalkDir,
  stripOutputsIgnoreRules,
} from './vcs-ignore'
import { buildVcsExcludeContent } from './vcs-git-cli'

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

  it('shouldSkipWalkDir 仅根层跳过 projects', () => {
    expect(shouldSkipWalkDir('', 'projects')).toBe(true)
    expect(shouldSkipWalkDir('outputs/demo', 'projects')).toBe(false)
    expect(shouldSkipWalkDir('', 'node_modules')).toBe(true)
  })

  it('shouldSkipWalkDir 跳过应用元数据 .lumii（缩略图缓存/回收站）', () => {
    // 缓存上限 500MB、可达数万文件；扫进去会让每轮快照退化到伪哈希
    expect(shouldSkipWalkDir('', '.lumii')).toBe(true)
    expect(shouldSkipWalkDir('outputs/demo', '.lumii')).toBe(true)
  })

  it('硬剪枝规则含 .lumii/ 但不含 outputs', () => {
    const c = buildVcsExcludeContent().split('\n')
    expect(c).toContain('.lumii/')
    expect(c).not.toContain('outputs/')
  })

  it('硬剪枝规则排除二进制，但不排除 outputs 目录本身', () => {
    const c = buildVcsExcludeContent()
    // 实测 1.9GB 的对象库里 1.25GB 是 PNG —— 这几条是主要收益来源
    for (const ext of ['*.png', '*.jpg', '*.mp4', '*.mp3', '*.pdf']) {
      expect(c.split('\n')).toContain(ext)
    }
    // outputs/ 必须仍被跟踪（快照要能回滚文档）
    expect(c.split('\n')).not.toContain('outputs/')
    expect(c.split('\n')).not.toContain('/outputs/')
  })
})
