// @vitest-environment node
/**
 * 产物导出：路径归一、越界拒绝、重名改名、zip 可回读、超限拒绝。
 * 用真文件系统（临时目录）——这一层就是要验证 IO 行为。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { exportArtifacts, MAX_EXPORT_BYTES, resolveExportFiles } from './artifact-export'

let base = ''
let root = ''

async function writeFileAt(rel: string, content = 'x'): Promise<string> {
  const abs = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'lumii-export-'))
  root = path.join(base, 'ws')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('resolveExportFiles', () => {
  it('归一化路径并去重；绝对路径/.. 一律拒绝', async () => {
    await writeFileAt('outputs/x/a.png', 'aaa')
    await writeFileAt('outputs/x/b.png', 'bbb')

    const ok = await resolveExportFiles(root, ['outputs/x/a.png', './outputs/x/a.png'])
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.files.map((file) => file.rel)).toEqual(['outputs/x/a.png'])

    for (const bad of ['/etc/passwd', 'C:/Windows/win.ini', '../outside.png', 'outputs/../../x']) {
      const result = await resolveExportFiles(root, [bad])
      expect(result.ok).toBe(false)
    }
  })

  it('不存在的文件与非普通文件（符号链接）都整体失败', async () => {
    expect((await resolveExportFiles(root, ['outputs/none.png'])).ok).toBe(false)

    await writeFileAt('outputs/x/real.png', 'r')
    try {
      await symlink(path.join(root, 'outputs/x/real.png'), path.join(root, 'outputs/x/link.png'))
      const viaLink = await resolveExportFiles(root, ['outputs/x/link.png'])
      expect(viaLink.ok).toBe(false)
    } catch {
      // Windows 无权限建 symlink 时跳过这条分支（不是本模块的问题）
    }
  })
})

describe('exportArtifacts', () => {
  it('zip 保留相对目录结构，可被 jszip 重新读出', async () => {
    await writeFileAt('outputs/x/a.png', 'aaa')
    await writeFileAt('outputs/y/b.md', '# hi')
    const dest = path.join(base, 'out', 'pack.zip')

    const result = await exportArtifacts({
      workspaceDir: root,
      relPaths: ['outputs/x/a.png', 'outputs/y/b.md'],
      mode: 'zip',
      destPath: dest,
    })
    expect(result.ok).toBe(true)
    expect(result.exported).toBe(2)

    const zip = await JSZip.loadAsync(await readFile(dest))
    // streamFiles 会给每级目录补条目；只比文件
    const entries = Object.keys(zip.files)
      .filter((name) => !zip.files[name]!.dir)
      .sort()
    expect(entries).toEqual(['outputs/x/a.png', 'outputs/y/b.md'])
    expect(await zip.file('outputs/y/b.md')!.async('string')).toBe('# hi')
  })

  it('copy 平铺到目标目录，重名自动加序号，不覆盖已有文件', async () => {
    await writeFileAt('outputs/a/same.png', 'first')
    await writeFileAt('outputs/b/same.png', 'second')
    const dest = path.join(base, 'flat')
    await mkdir(dest, { recursive: true })
    await writeFile(path.join(dest, 'same.png'), 'existing', 'utf8')

    const result = await exportArtifacts({
      workspaceDir: root,
      relPaths: ['outputs/a/same.png', 'outputs/b/same.png'],
      mode: 'copy',
      destPath: dest,
    })
    expect(result.ok).toBe(true)
    expect(result.exported).toBe(2)
    expect(await readFile(path.join(dest, 'same.png'), 'utf8')).toBe('existing')
    expect(await readFile(path.join(dest, 'same (2).png'), 'utf8')).toBe('first')
    expect(await readFile(path.join(dest, 'same (3).png'), 'utf8')).toBe('second')
  })

  it('总量超过 500MB 直接拒绝，不写任何文件', async () => {
    const sparse = path.join(base, 'big.bin')
    // 用 truncate 造一个稀疏大文件，别真写 500MB
    await writeFile(sparse, '')
    const { truncate } = await import('node:fs/promises')
    await truncate(sparse, MAX_EXPORT_BYTES + 1)
    const rel = 'big.bin'
    const dest = path.join(base, 'ws', 'big.bin')
    await mkdir(path.dirname(dest), { recursive: true })
    await (await import('node:fs/promises')).copyFile(sparse, dest)

    const result = await exportArtifacts({
      workspaceDir: root,
      relPaths: [rel],
      mode: 'zip',
      destPath: path.join(base, 'too-big.zip'),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/500MB/)
    await expect(readFile(path.join(base, 'too-big.zip'))).rejects.toThrow()
  })
})

describe('导出历史版本副本（P2 T6）', () => {
  it('另存为写出的是物化副本的旧内容，当前文件不变', async () => {
    await writeFileAt('outputs/x/doc.md', 'CURRENT')
    await writeFileAt('.lumii/exports/versions/abc123/doc.md', 'OLD-VERSION')

    const savedPath = path.join(base, 'saved.md')
    const saved = await exportArtifacts({
      workspaceDir: root,
      relPaths: ['.lumii/exports/versions/abc123/doc.md'],
      mode: 'save',
      destPath: savedPath,
    })
    expect(saved.ok).toBe(true)
    expect(await readFile(savedPath, 'utf8')).toBe('OLD-VERSION')
    expect(await readFile(path.join(root, 'outputs/x/doc.md'), 'utf8')).toBe('CURRENT')
  })
})
