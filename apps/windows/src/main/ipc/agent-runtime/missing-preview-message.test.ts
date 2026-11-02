/**
 * @vitest-environment node
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeMissingPreviewFile } from './missing-preview-message'

describe('describeMissingPreviewFile', () => {
  const tmpRoots: string[] = []

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  /** 建临时目录并登记清理 */
  function makeDir(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-missing-preview-'))
    tmpRoots.push(root)
    return root
  }

  it('普通缺失：带上相对路径提示', () => {
    const root = makeDir()
    const abs = path.join(root, 'outputs', 'clip.mp4')
    expect(describeMissingPreviewFile(abs, root)).toBe(
      '文件不存在或已被删除：outputs/clip.mp4',
    )
  })

  it('同目录有未完成 .part：提示下载未完成', () => {
    const root = makeDir()
    const dir = path.join(root, 'outputs', 'video-downloads', 'web')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'abc123.f30080.mp4.part'), 'partial')
    const abs = path.join(dir, 'abc123.mp4')
    expect(describeMissingPreviewFile(abs, root)).toMatch(/下载未完成/)
    expect(describeMissingPreviewFile(abs, root)).toMatch(/outputs\/video-downloads\/web\/abc123\.mp4/)
  })

  it('工作区外绝对路径：仍返回可读提示', () => {
    const abs = path.join(os.tmpdir(), 'no-such-preview-file-xyz.mp4')
    expect(describeMissingPreviewFile(abs, makeDir())).toMatch(/文件不存在或已被删除/)
  })
})
