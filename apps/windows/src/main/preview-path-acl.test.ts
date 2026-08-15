/**
 * 预览路径 ACL 单测
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAllowedPreviewPath, isPathUnderDir } from './preview-path-acl'

describe('isPathUnderDir', () => {
  it('目录本身与子路径允许，兄弟路径拒绝', () => {
    const dir = path.resolve('E:/data/recordings')
    expect(isPathUnderDir(dir, dir)).toBe(true)
    expect(isPathUnderDir(path.join(dir, 'a.webm'), dir)).toBe(true)
    expect(isPathUnderDir(path.resolve('E:/data/other/a.webm'), dir)).toBe(false)
  })
})

describe('isAllowedPreviewPath', () => {
  const dirs = {
    workspaceCwd: path.resolve('E:/ws'),
    recordingsDir: path.resolve('E:/home/.lumii/recordings'),
    screenshotDir: path.resolve('E:/home/.lumii/temp/screenshots'),
  }

  it('放行工作区、recordings、screenshots', () => {
    expect(isAllowedPreviewPath(path.join(dirs.workspaceCwd, 'a.md'), dirs)).toBe(true)
    expect(isAllowedPreviewPath(path.join(dirs.recordingsDir, 'x.webm'), dirs)).toBe(true)
    expect(isAllowedPreviewPath(path.join(dirs.screenshotDir, 's.jpg'), dirs)).toBe(true)
  })

  it('拒绝目录外路径', () => {
    expect(isAllowedPreviewPath(path.resolve('E:/evil/secret.webm'), dirs)).toBe(false)
  })
})
