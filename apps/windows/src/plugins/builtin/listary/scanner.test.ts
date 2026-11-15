/**
 * scanner 单测 —— 纯逻辑，不需要 FTS5，可在 vitest（plain Node）下跑。
 *
 * 需要 FTS5 的全链路（db/writer/query）在 `verify/listary-p1/` 里用 Electron 跑，
 * 原因见 `db.ts` 顶部：plain Node 的 node:sqlite 不带 FTS5。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SKIP_DIRS, normalizePath, scanSync, shouldSkipDir } from './scanner.js'
import type { IndexItem } from './db.js'

const tempDirs: string[] = []

function makeTree(spec: Record<string, string | null>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-listary-scan-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel)
    if (content === null) {
      fs.mkdirSync(full, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    }
  }
  return root
}

function collect(root: string, extra: Partial<Parameters<typeof scanSync>[0]> = {}): IndexItem[] {
  const items: IndexItem[] = []
  scanSync({ roots: [root], onBatch: (b) => items.push(...b), ...extra })
  return items
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('shouldSkipDir', () => {
  const skip = new Set(DEFAULT_SKIP_DIRS)

  it('跳过依赖与版本控制目录', () => {
    expect(shouldSkipDir('node_modules', skip)).toBe(true)
    expect(shouldSkipDir('.git', skip)).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(shouldSkipDir('NODE_MODULES', skip)).toBe(true)
    expect(shouldSkipDir('Node_Modules', skip)).toBe(true)
  })

  it('不跳过正常业务目录', () => {
    expect(shouldSkipDir('src', skip)).toBe(false)
    expect(shouldSkipDir('docs', skip)).toBe(false)
  })
})

describe('normalizePath', () => {
  it('正斜杠转反斜杠，盘符统一小写', () => {
    expect(normalizePath('C:/a/b.txt')).toBe('c:\\a\\b.txt')
  })

  it('盘符转小写（用于去重，盘符大小写不该产生两条）', () => {
    expect(normalizePath('C:\\A\\b.txt')).toBe('c:\\A\\b.txt')
    expect(normalizePath('e:\\x')).toBe('e:\\x')
  })

  it('UNC 路径保持不变（不去动开头的反斜杠）', () => {
    expect(normalizePath('\\\\server\\share\\a.txt')).toBe('\\\\server\\share\\a.txt')
  })
})

describe('scanSync', () => {
  it('扫到文件与目录，并分类 kind', () => {
    const root = makeTree({
      'src/index.ts': 'x',
      'src/app.exe': 'x',
      'readme.md': 'x',
      'shortcut.lnk': 'x',
      'empty/.keep': 'x',
    })
    const items = collect(root)
    const byName = (n: string): IndexItem | undefined => items.find((i) => i.name === n)

    expect(byName('index.ts')?.kind).toBe('file')
    expect(byName('app.exe')?.kind).toBe('app')
    expect(byName('shortcut.lnk')?.kind).toBe('lnk')
    expect(byName('empty')?.kind).toBe('dir')
    expect(byName('readme.md')?.ext).toBe('.md')
    expect(byName('empty')?.ext).toBeNull()
  })

  it('跳过 node_modules / .git 等目录，且不递归进去', () => {
    const root = makeTree({
      'src/a.ts': 'x',
      'node_modules/pkg/index.js': 'x',
      '.git/config': 'x',
      'node_modules/pkg/deep/nested.js': 'x',
    })
    const items = collect(root)
    const names = items.map((i) => i.name)

    expect(names).toContain('a.ts')
    expect(names).not.toContain('index.js')
    expect(names).not.toContain('nested.js')
    expect(names).not.toContain('config')
    expect(names).not.toContain('node_modules')
  })

  it('遵守 maxDepth', () => {
    const root = makeTree({
      'l1/l2/l3/l4/deep.txt': 'x',
      'top.txt': 'x',
    })
    const shallow = collect(root, { maxDepth: 2 })
    expect(shallow.map((i) => i.name)).not.toContain('deep.txt')
    expect(shallow.map((i) => i.name)).toContain('top.txt')

    const deep = collect(root, { maxDepth: 10 })
    expect(deep.map((i) => i.name)).toContain('deep.txt')
  })

  it('root 字段记录所属索引根（用于增量与优先级）', () => {
    const root = makeTree({ 'a/b/c.txt': 'x' })
    const items = collect(root)
    const norm = normalizePath(root)
    for (const i of items) expect(i.root).toBe(norm)
  })

  it('按 batchSize 分批回调（不一次性堆大数组）', () => {
    const spec: Record<string, string> = {}
    for (let i = 0; i < 25; i++) spec[`f${i}.txt`] = 'x'
    const root = makeTree(spec)
    const batches: number[] = []
    scanSync({ roots: [root], batchSize: 10, onBatch: (b) => batches.push(b.length) })

    // 25 个文件 + 根目录自身 1 条 = 26
    const total = batches.reduce((a, b) => a + b, 0)
    expect(total).toBe(26)
    expect(batches.length).toBeGreaterThan(1)
    for (const n of batches) expect(n).toBeLessThanOrEqual(10)
  })

  it('批量切割不丢条目', () => {
    const spec: Record<string, string> = {}
    for (let i = 0; i < 7; i++) spec[`g${i}.txt`] = 'x'
    const root = makeTree(spec)
    const seen: string[] = []
    const res = scanSync({ roots: [root], batchSize: 3, onBatch: (b) => seen.push(...b.map((i) => i.name)) })
    // 7 个文件 + 根目录，无重复
    expect(seen.length).toBe(8)
    expect(new Set(seen).size).toBe(8)
    expect(res.indexed).toBe(8)
  })

  it('根目录不存在时计入 failedDirs 且不抛', () => {
    const root = makeTree({ 'a.txt': 'x' })
    const res = scanSync({ roots: [path.join(root, 'does-not-exist')], onBatch: () => {} })
    expect(res.failedDirs).toBe(1)
    expect(res.indexed).toBe(0)
  })

  it('根目录自身也算一条条目（用户会搜目录名）', () => {
    const root = makeTree({ 'a.txt': 'x' })
    const items = collect(root)
    const self = items.find((i) => i.path === normalizePath(root))
    expect(self).toBeDefined()
    expect(self?.kind).toBe('dir')
  })

  it('abort 后停止扫描', () => {
    const spec: Record<string, string> = {}
    for (let i = 0; i < 30; i++) spec[`d${i}/f.txt`] = 'x'
    const root = makeTree(spec)
    const ac = new AbortController()
    let count = 0
    const res = scanSync({
      roots: [root],
      batchSize: 1,
      signal: ac.signal,
      onBatch: (b) => {
        count += b.length
        if (count >= 5) ac.abort()
      },
    })
    expect(res.aborted).toBe(true)
    expect(count).toBeLessThan(31)
  })

  it('不把符号链接当普通条目（避免跟随成环）', () => {
    const root = makeTree({ 'real/a.txt': 'x' })
    // 建一个指向父目录的链接；若被跟随会成环
    const link = path.join(root, 'loop')
    try {
      fs.symlinkSync(root, link, 'junction')
    } catch {
      return // 无权限建链接则跳过（CI/受限环境）
    }
    const items = collect(root)
    expect(items.map((i) => i.name)).not.toContain('loop')
  })
})
