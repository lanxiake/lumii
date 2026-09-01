/**
 * Wiki ref 预览跟到原文件的解析测试
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWikiRefPreviewTarget } from './resolve-wiki-ref-preview'

function writeFileRef(refPath: string, title: string, targetPath: string): void {
  fs.writeFileSync(
    refPath,
    `${JSON.stringify({
      kind: 'wiki-ref',
      version: 1,
      refType: 'file',
      title,
      targetPath,
      linkedAt: new Date().toISOString(),
    })}\n`,
  )
}

const dirs: string[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ref-preview-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveWikiRefPreviewTarget', () => {
  it('非 ref 路径原样返回', () => {
    const abs = path.join(tmpDir(), 'a.pdf')
    expect(resolveWikiRefPreviewTarget(abs)).toBe(abs)
  })

  it('file-ref 跟到 targetPath 指向的文件', () => {
    const dir = tmpDir()
    const pdf = path.join(dir, '一年级.pdf')
    fs.writeFileSync(pdf, '%PDF-1.4')
    const ref = path.join(dir, '资料.lumii-ref')
    writeFileRef(ref, '资料', pdf)
    expect(resolveWikiRefPreviewTarget(ref)).toBe(path.resolve(pdf))
  })

  it('targetPath 为文件夹且其中有一份 PDF 时选中该文件', () => {
    const dir = tmpDir()
    const folder = path.join(dir, '教材')
    fs.mkdirSync(folder)
    const pdf = path.join(folder, '一年级语文下册.pdf')
    fs.writeFileSync(pdf, '%PDF-1.4')
    const ref = path.join(dir, 'wiki-cli-real-pdf——一年级语文下册.lumii-ref')
    writeFileRef(ref, 'wiki-cli-real-pdf——一年级语文下册', folder)
    expect(resolveWikiRefPreviewTarget(ref)).toBe(path.resolve(pdf))
  })

  it('targetPath 指向另一份 .lumii-ref 时继续跟到真正的文件', () => {
    const workspace = tmpDir()
    const inbox = path.join(workspace, 'wiki', '收件箱')
    fs.mkdirSync(inbox, { recursive: true })
    const pdf = path.join(workspace, '一年级语文下册.pdf')
    fs.writeFileSync(pdf, '%PDF-1.4')
    const inner = path.join(inbox, 'wiki-cli-real-pdf-一年级语文下册-2.lumii-ref')
    writeFileRef(inner, '一年级语文下册', pdf)
    const outer = path.join(inbox, 'wiki-cli-real-pdf-一年级语文下册.lumii-ref')
    writeFileRef(outer, 'wiki-cli-real-pdf-一年级语文下册', 'wiki/收件箱/wiki-cli-real-pdf-一年级语文下册-2.lumii-ref')
    expect(resolveWikiRefPreviewTarget(outer, workspace)).toBe(path.resolve(pdf))
  })
})
