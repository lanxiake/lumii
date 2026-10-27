// @vitest-environment node
/**
 * 中间产物去重（P2 T9）：只碰中间产物、硬链接可回读、引用跳过、EXDEV 回放、崩溃恢复。
 * 真文件系统——这一层的价值全在 inode / nlink / 磁盘行为上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { utimes } from 'node:fs/promises'
import {
  applyDedupe,
  planDedupe,
  recoverDedupeTemps,
} from './workspace-dedupe'
import { DEDUPE_MIN_BYTES } from '../shared/workspace-dedupe-types'

let base = ''
let root = ''

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-dedupe-'))
  root = path.join(base, 'ws')
  await fs.mkdir(root, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(base, { recursive: true, force: true })
})

async function writeAt(rel: string, content: string | Buffer, oldMs = 3 * 24 * 3600 * 1000): Promise<void> {
  const abs = path.join(root, ...rel.split('/'))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
  if (oldMs > 0) {
    const when = new Date(Date.now() - oldMs)
    await utimes(abs, when, when)
  }
}

const SAME = 'identical-content'.repeat(200)
/** ≥64KB 的另一份内容（默认阈值那组用） */
const BIG = 'fresh-content-'.repeat(6000)

describe('planDedupe', () => {
  it('只列中间产物：成品/临时/内部不参与', async () => {
    await writeAt('outputs/demo/parts/a.bin', SAME)
    await writeAt('outputs/demo/parts/b.bin', SAME)
    await writeAt('outputs/demo/parts/c.bin', SAME)
    // 成品（同内容）、临时、内部都不是候选
    await writeAt('outputs/demo/cover.bin', SAME)
    await writeAt('temp/x.bin', SAME)
    await writeAt('.lumii/cache/y.bin', SAME)

    const result = await planDedupe({ dir: root, minBytes: 1, minAgeMs: 0 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.groups).toHaveLength(1)
    const group = result.plan.groups[0]!
    expect(group.keep).toBe('outputs/demo/parts/a.bin')
    expect(group.duplicates).toEqual([
      'outputs/demo/parts/b.bin',
      'outputs/demo/parts/c.bin',
    ])
    expect(result.plan.totalFiles).toBe(2)
    expect(result.plan.reclaimableBytes).toBe(group.size * 2)
    expect(result.plan.truncated).toBe(false)
  })

  it('太小 / 太新的候选进 skipped，不参与去重', async () => {
    await writeAt('outputs/demo/parts/small-a.bin', 'x', 0)
    await writeAt('outputs/demo/parts/small-b.bin', 'x', 0)
    await writeAt('outputs/demo/parts/fresh-a.bin', BIG, 0)
    await writeAt('outputs/demo/parts/fresh-b.bin', BIG, 0)

    const result = await planDedupe({ dir: root, minBytes: DEDUPE_MIN_BYTES, minAgeMs: 24 * 3600 * 1000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.groups).toEqual([])
    const reasons = new Map(result.plan.skipped.map((item) => [item.path, item.reason]))
    expect(reasons.get('outputs/demo/parts/small-a.bin')).toBe('too-small')
    expect(reasons.get('outputs/demo/parts/fresh-a.bin')).toBe('too-recent')
  })

  it('被成品引用的文件名跳过', async () => {
    await writeAt('outputs/demo/parts/a.bin', SAME)
    await writeAt('outputs/demo/parts/b.bin', SAME)
    await writeAt('outputs/demo/cover.md', '![x](parts/b.bin)\n')

    const result = await planDedupe({ dir: root, minBytes: 1, minAgeMs: 0 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.groups).toEqual([])
    expect(result.plan.skipped).toContainEqual({
      path: 'outputs/demo/parts/b.bin',
      reason: 'referenced',
    })
  })
})

describe('applyDedupe', () => {
  it('硬链接替换：inode 相同、nlink 正确、内容仍可读、腾出空间', async () => {
    await writeAt('outputs/demo/parts/a.bin', SAME)
    await writeAt('outputs/demo/parts/b.bin', SAME)
    await writeAt('outputs/demo/parts/c.bin', SAME)

    const result = await applyDedupe({
      dir: root,
      minBytes: 1,
      minAgeMs: 0,
      logDir: path.join(root, '.logs'),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.linked).toBe(2)
    expect(result.failed).toEqual([])
    expect(result.freedBytes).toBe(Buffer.byteLength(SAME) * 2)

    const stats = await Promise.all(
      ['a.bin', 'b.bin', 'c.bin'].map((name) =>
        fs.stat(path.join(root, 'outputs', 'demo', 'parts', name)),
      ),
    )
    expect(stats[0]!.ino).toBe(stats[1]!.ino)
    expect(stats[1]!.ino).toBe(stats[2]!.ino)
    expect(stats[0]!.nlink).toBe(3)
    expect(await fs.readFile(path.join(root, 'outputs', 'demo', 'parts', 'b.bin'), 'utf8')).toBe(SAME)
    // 临时目录与 journal 都清理干净
    await expect(fs.stat(path.join(root, '.lumii', 'tmp', 'dedupe-journal.json'))).rejects.toThrow()
  })

  it('EXDEV：该文件放回原位并报「跨卷」', async () => {
    await writeAt('outputs/demo/parts/a.bin', SAME)
    await writeAt('outputs/demo/parts/b.bin', SAME)
    const linkSpy = vi.spyOn(fs, 'link').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }),
    )

    const result = await applyDedupe({
      dir: root,
      minBytes: 1,
      minAgeMs: 0,
      logDir: path.join(root, '.logs'),
    })
    expect(linkSpy).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.linked).toBe(0)
    expect(result.failed[0]).toMatchObject({
      path: 'outputs/demo/parts/b.bin',
      reason: '跨卷不支持硬链接',
    })
    // 原文件回来了，内容完整
    expect(await fs.readFile(path.join(root, 'outputs', 'demo', 'parts', 'b.bin'), 'utf8')).toBe(SAME)
  })
})

describe('recoverDedupeTemps', () => {
  it('崩在中途：临时副本放回原位；目标已存在则清掉临时副本', async () => {
    const journal = path.join(root, '.lumii', 'tmp', 'dedupe-journal.json')
    await fs.mkdir(path.dirname(journal), { recursive: true })
    await writeAt('.lumii/tmp/dedupe/run-0', 'orphan-1', 0)
    await writeAt('.lumii/tmp/dedupe/run-1', 'orphan-2', 0)
    await writeAt('outputs/demo/parts/target-b.bin', 'already', 0)
    await fs.writeFile(
      journal,
      JSON.stringify({
        entries: [
          { tmp: '.lumii/tmp/dedupe/run-0', target: 'outputs/demo/parts/target-a.bin', keep: 'x' },
          { tmp: '.lumii/tmp/dedupe/run-1', target: 'outputs/demo/parts/target-b.bin', keep: 'x' },
        ],
      }),
    )

    const result = await recoverDedupeTemps({ dir: root })
    expect(result).toEqual({ restored: 1, dropped: 1 })
    expect(
      await fs.readFile(path.join(root, 'outputs', 'demo', 'parts', 'target-a.bin'), 'utf8'),
    ).toBe('orphan-1')
    expect(
      await fs.readFile(path.join(root, 'outputs', 'demo', 'parts', 'target-b.bin'), 'utf8'),
    ).toBe('already')
    await expect(fs.stat(journal)).rejects.toThrow()
  })
})
