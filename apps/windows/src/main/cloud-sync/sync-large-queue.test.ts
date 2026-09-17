/**
 * sync-large-queue 单元测试：待传集合扫描、批次切分。
 *
 * pump 的编排逻辑依赖 git/manger，由集成测试覆盖；这里只测两个纯函数 ——
 * 它们是这个模块唯一有正确性风险的部分（扫漏 = 大文件永远传不上去，
 * 扫多 = 重复上传数百 MB）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanPendingLargeFiles, splitIntoBatches, type LargeFileEntry } from './sync-large-queue'

describe('sync-large-queue', () => {
  let root: string

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  })

  /** 建一对 workspace/outputs 与 sync/workspace/outputs 目录 */
  function makePair(): { src: string; dst: string } {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-large-queue-'))
    const src = path.join(root, 'workspace', 'outputs')
    const dst = path.join(root, 'sync', 'workspace', 'outputs')
    fs.mkdirSync(src, { recursive: true })
    fs.mkdirSync(dst, { recursive: true })
    return { src, dst }
  }

  /** 写文件并固定 mtime（避免测试机时间精度抖动） */
  const write = (p: string, content: string, mtime?: Date): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    if (mtime) fs.utimesSync(p, mtime, mtime)
  }

  const entry = (repoPath: string, size: number): LargeFileEntry => ({
    repoPath,
    absPath: `/x/${repoPath}`,
    size,
  })

  // ── scanPendingLargeFiles ──────────────────────────────────────────────

  it('扫描：≤ 阈值的文件不归阶段二', () => {
    const { src, dst } = makePair()
    write(path.join(src, 'small.md'), 'x'.repeat(100))

    const pending = scanPendingLargeFiles({
      workspaceOutputsDir: src,
      syncOutputsDir: dst,
      thresholdBytes: 1024,
    })

    expect(pending).toEqual([])
  })

  it('扫描：> 阈值且 sync 侧没有 → 待传', () => {
    const { src, dst } = makePair()
    write(path.join(src, 'big.mp4'), 'x'.repeat(4096))

    const pending = scanPendingLargeFiles({
      workspaceOutputsDir: src,
      syncOutputsDir: dst,
      thresholdBytes: 1024,
    })

    expect(pending).toHaveLength(1)
    expect(pending[0].repoPath).toBe('workspace/outputs/big.mp4')
    expect(pending[0].size).toBe(4096)
  })

  it('扫描：size + mtime 一致 → 已同步，不重传', () => {
    const { src, dst } = makePair()
    const fixed = new Date('2026-09-17T10:00:00Z')
    write(path.join(src, 'big.mp4'), 'x'.repeat(4096), fixed)
    write(path.join(dst, 'big.mp4'), 'x'.repeat(4096), fixed)

    const pending = scanPendingLargeFiles({
      workspaceOutputsDir: src,
      syncOutputsDir: dst,
      thresholdBytes: 1024,
    })

    expect(pending).toEqual([])
  })

  it('扫描：mtime 变化（等长改写）→ 重传', () => {
    const { src, dst } = makePair()
    const older = new Date('2026-09-17T10:00:00Z')
    const newer = new Date('2026-09-17T11:00:00Z')
    write(path.join(dst, 'big.mp4'), 'x'.repeat(4096), older)
    write(path.join(src, 'big.mp4'), 'y'.repeat(4096), newer)

    const pending = scanPendingLargeFiles({
      workspaceOutputsDir: src,
      syncOutputsDir: dst,
      thresholdBytes: 1024,
    })

    expect(pending).toHaveLength(1)
  })

  it('扫描：size 变化 → 重传', () => {
    const { src, dst } = makePair()
    const fixed = new Date('2026-09-17T10:00:00Z')
    write(path.join(dst, 'big.mp4'), 'x'.repeat(4096), fixed)
    write(path.join(src, 'big.mp4'), 'x'.repeat(8192), fixed)

    const pending = scanPendingLargeFiles({
      workspaceOutputsDir: src,
      syncOutputsDir: dst,
      thresholdBytes: 1024,
    })

    expect(pending).toHaveLength(1)
    expect(pending[0].size).toBe(8192)
  })

  it('扫描：递归子目录，跳过 .git 等重目录', () => {
    const { src, dst } = makePair()
    write(path.join(src, 'a', 'b', 'big.mp4'), 'x'.repeat(4096))
    write(path.join(src, 'node_modules', 'big.mp4'), 'x'.repeat(4096))

    const pending = scanPendingLargeFiles({
      workspaceOutputsDir: src,
      syncOutputsDir: dst,
      thresholdBytes: 1024,
    })

    expect(pending).toHaveLength(1)
    expect(pending[0].repoPath).toBe('workspace/outputs/a/b/big.mp4')
  })

  it('扫描：mtime 亚毫秒舍入差异不导致重复待传（队列死循环回归）', () => {
    // 真实故障（2026-09-17）：队列连跑 108 批全在传同一个 32.5MB 文件 ——
    // 源 mtime 带亚毫秒小数，utimesSync 回写后读回被舍入，严格比较永远为 false。
    const { src, dst } = makePair()
    const srcFile = path.join(src, 'big.mp4')
    fs.writeFileSync(srcFile, 'x'.repeat(4096))
    fs.utimesSync(srcFile, 1789142563.4877817, 1789142563.4877817)

    // 模拟"已复制并回写 mtime"的目标
    const dstFile = path.join(dst, 'big.mp4')
    fs.copyFileSync(srcFile, dstFile)
    const st = fs.statSync(srcFile)
    fs.utimesSync(dstFile, st.atime, st.mtime)

    const pending = scanPendingLargeFiles({
      workspaceOutputsDir: src,
      syncOutputsDir: dst,
      thresholdBytes: 1024,
    })

    expect(pending).toEqual([])
  })

  it('扫描：源目录不存在 → 空结果（不抛错）', () => {
    const { dst } = makePair()
    const pending = scanPendingLargeFiles({
      workspaceOutputsDir: path.join(root, 'nope'),
      syncOutputsDir: dst,
      thresholdBytes: 1024,
    })
    expect(pending).toEqual([])
  })

  // ── splitIntoBatches ───────────────────────────────────────────────────

  it('切批：空输入 → 空批次', () => {
    expect(splitIntoBatches([], 1000)).toEqual([])
  })

  it('切批：累计不超上限时合成一批', () => {
    const batches = splitIntoBatches([entry('a', 100), entry('b', 200)], 1000)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
  })

  it('切批：超上限时开新批', () => {
    const batches = splitIntoBatches([entry('a', 600), entry('b', 600)], 1000)
    expect(batches).toHaveLength(2)
    expect(batches[0].map((e) => e.repoPath)).toEqual(['a'])
    expect(batches[1].map((e) => e.repoPath)).toEqual(['b'])
  })

  it('切批：单文件超上限时独占一批（不拆文件）', () => {
    const batches = splitIntoBatches([entry('huge', 5000), entry('small', 100)], 1000)
    expect(batches).toHaveLength(2)
    expect(batches[0].map((e) => e.repoPath)).toEqual(['huge'])
    expect(batches[1].map((e) => e.repoPath)).toEqual(['small'])
  })

  it('切批：边界值恰好等于上限不拆', () => {
    const batches = splitIntoBatches([entry('a', 500), entry('b', 500)], 1000)
    expect(batches).toHaveLength(1)
  })
})
