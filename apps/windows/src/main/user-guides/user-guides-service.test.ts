/**
 * 内置使用指南服务测试
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

const tmpDirs: string[] = []

afterEach(() => {
  vi.resetModules()
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

function seedGuidesDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-guides-'))
  tmpDirs.push(dir)
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      guides: [
        {
          id: 'wiki',
          title: 'Wiki 手册',
          category: 'memory',
          description: 'test',
          tags: ['wiki'],
          file: 'wiki-user-guide.md',
          seedToWiki: false,
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
    'utf8',
  )
  fs.writeFileSync(path.join(dir, 'wiki-user-guide.md'), '# Wiki\n\n正文', 'utf8')
  return dir
}

describe('user-guides-service', () => {
  it('listBundledUserGuides 返回 manifest 条目', async () => {
    const dir = seedGuidesDir()
    vi.doMock('../user-guides/user-guides-paths', () => ({
      resolveUserGuidesDir: () => dir,
      getUserGuidesDir: () => dir,
    }))
    const { listBundledUserGuides } = await import('../user-guides/user-guides-service')
    const list = listBundledUserGuides()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('wiki')
  })

  it('readBundledUserGuide 读取 Markdown', async () => {
    const dir = seedGuidesDir()
    vi.doMock('../user-guides/user-guides-paths', () => ({
      resolveUserGuidesDir: () => dir,
      getUserGuidesDir: () => dir,
    }))
    const { readBundledUserGuide } = await import('../user-guides/user-guides-service')
    const content = readBundledUserGuide('wiki')
    expect(content.title).toBe('Wiki 手册')
    expect(content.markdown).toContain('# Wiki')
  })
})
