/**
 * sync-copy 单元测试：跳过 .git、5MB 大文件阈值、单文件复制失败不阻断。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SYNC_OUTPUTS_MAX_BYTES,
  computeStaleFingerprint,
  copySyncDirectory,
  shouldSkipSyncCopyDir,
} from './sync-copy'

describe('sync-copy', () => {
  let root: string

  afterEach(() => {
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  /** 在临时目录下准备 src/dst 一对路径 */
  function makePair(): { src: string; dst: string } {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-copy-'))
    const src = path.join(root, 'src')
    const dst = path.join(root, 'dst')
    fs.mkdirSync(src, { recursive: true })
    return { src, dst }
  }

  it('shouldSkipSyncCopyDir 识别 .git 与 node_modules', () => {
    expect(shouldSkipSyncCopyDir('.git')).toBe(true)
    expect(shouldSkipSyncCopyDir('node_modules')).toBe(true)
    expect(shouldSkipSyncCopyDir('outputs')).toBe(false)
  })

  it('outputs 默认上限为 5MB', () => {
    expect(SYNC_OUTPUTS_MAX_BYTES).toBe(5 * 1024 * 1024)
  })

  it('递归复制时跳过嵌套 .git 目录', () => {
    const { src, dst } = makePair()
    const nested = path.join(src, 'repo')
    fs.mkdirSync(path.join(nested, '.git', 'objects'), { recursive: true })
    fs.writeFileSync(path.join(nested, '.git', 'HEAD'), 'ref: refs/heads/main')
    fs.writeFileSync(path.join(nested, '.git', 'objects', 'pack.idx'), 'locked')
    fs.writeFileSync(path.join(nested, 'readme.md'), 'ok')

    const result = copySyncDirectory(src, dst)

    expect(result.copied).toBe(1)
    expect(result.skippedDirs).toBe(1)
    expect(result.errors).toEqual([])
    expect(fs.existsSync(path.join(dst, 'repo', 'readme.md'))).toBe(true)
    expect(fs.existsSync(path.join(dst, 'repo', '.git'))).toBe(false)
  })

  it('超过 maxSize 的文件跳过且不报错', () => {
    const { src, dst } = makePair()
    fs.writeFileSync(path.join(src, 'small.txt'), 'hi')
    fs.writeFileSync(path.join(src, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 1))

    const result = copySyncDirectory(src, dst, { maxSize: SYNC_OUTPUTS_MAX_BYTES })

    expect(result.copied).toBe(1)
    expect(result.skippedLarge).toBe(1)
    expect(result.errors).toEqual([])
    expect(fs.existsSync(path.join(dst, 'small.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dst, 'big.bin'))).toBe(false)
  })

  it('≤5MB 的文件会被复制', () => {
    const { src, dst } = makePair()
    const size = 2 * 1024 * 1024
    fs.writeFileSync(path.join(src, 'mid.bin'), Buffer.alloc(size, 2))

    const result = copySyncDirectory(src, dst, { maxSize: SYNC_OUTPUTS_MAX_BYTES })

    expect(result.copied).toBe(1)
    expect(result.skippedLarge).toBe(0)
    expect(fs.statSync(path.join(dst, 'mid.bin')).size).toBe(size)
  })

  it('单文件复制失败记入 errors 后继续复制其余文件', () => {
    const { src, dst } = makePair()
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')
    fs.writeFileSync(path.join(src, 'b.txt'), 'b')
    fs.mkdirSync(dst, { recursive: true })
    // 在目标侧用同名目录占位，使 a.txt 的 copyFileSync 失败
    fs.mkdirSync(path.join(dst, 'a.txt'))

    const result = copySyncDirectory(src, dst)

    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('a.txt')
    expect(result.copied).toBe(1)
    expect(fs.readFileSync(path.join(dst, 'b.txt'), 'utf8')).toBe('b')
  })

  it('跳过 .git 时顺带删除目标侧残留', () => {
    const { src, dst } = makePair()
    const nested = path.join(src, 'repo')
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true })
    fs.writeFileSync(path.join(nested, '.git', 'HEAD'), 'ref')
    fs.writeFileSync(path.join(nested, 'ok.txt'), 'x')
    fs.mkdirSync(path.join(dst, 'repo', '.git'), { recursive: true })
    fs.writeFileSync(path.join(dst, 'repo', '.git', 'HEAD'), 'stale')

    const result = copySyncDirectory(src, dst)

    expect(result.skippedDirs).toBe(1)
    expect(fs.existsSync(path.join(dst, 'repo', '.git'))).toBe(false)
    expect(fs.readFileSync(path.join(dst, 'repo', 'ok.txt'), 'utf8')).toBe('x')
  })

  // ── mirror 模式：删除传播 ──────────────────────────────────────────────

  it('mirror 默认关闭：目标侧多余文件保留', () => {
    const { src, dst } = makePair()
    fs.mkdirSync(dst, { recursive: true })
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')
    fs.writeFileSync(path.join(dst, 'stale.txt'), 's')

    const result = copySyncDirectory(src, dst)

    expect(result.deleted).toBe(0)
    expect(result.deleteAborted).toBe(false)
    expect(fs.existsSync(path.join(dst, 'stale.txt'))).toBe(true)
  })

  it('mirror：删除目标侧源侧已不存在的文件与目录', () => {
    const { src, dst } = makePair()
    fs.mkdirSync(path.join(src, 'keep'), { recursive: true })
    fs.writeFileSync(path.join(src, 'keep', 'a.md'), 'a')
    fs.mkdirSync(path.join(dst, 'keep'), { recursive: true })
    fs.writeFileSync(path.join(dst, 'keep', 'a.md'), 'old')
    fs.mkdirSync(path.join(dst, 'gone'), { recursive: true })
    fs.writeFileSync(path.join(dst, 'gone', 'b.md'), 'b')
    fs.writeFileSync(path.join(dst, 'gone-file.md'), 'c')

    const result = copySyncDirectory(src, dst, { mirror: true })

    expect(result.deleted).toBe(2)
    expect(result.deleteAborted).toBe(false)
    expect(result.errors).toEqual([])
    expect(fs.readFileSync(path.join(dst, 'keep', 'a.md'), 'utf8')).toBe('a')
    expect(fs.existsSync(path.join(dst, 'gone'))).toBe(false)
    expect(fs.existsSync(path.join(dst, 'gone-file.md'))).toBe(false)
  })

  it('mirror：源目录不存在时不做任何删除', () => {
    const { src, dst } = makePair()
    fs.mkdirSync(dst, { recursive: true })
    fs.writeFileSync(path.join(dst, 'stale.txt'), 's')
    fs.rmSync(src, { recursive: true, force: true })

    const result = copySyncDirectory(src, dst, { mirror: true })

    expect(result.deleted).toBe(0)
    expect(result.deleteAborted).toBe(false)
    expect(fs.existsSync(path.join(dst, 'stale.txt'))).toBe(true)
  })

  it('mirror：待删数量超 maxDeletes 时整批放弃，一个都不删', () => {
    const { src, dst } = makePair()
    fs.mkdirSync(dst, { recursive: true })
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dst, `f${i}.txt`), 'x')

    const result = copySyncDirectory(src, dst, { mirror: true, maxDeletes: 3 })

    expect(result.deleteAborted).toBe(true)
    expect(result.deleted).toBe(0)
    for (let i = 0; i < 5; i++) {
      expect(fs.existsSync(path.join(dst, `f${i}.txt`))).toBe(true)
    }
  })

  it('mirror：待删占比超阈值时整批放弃', () => {
    const { src, dst } = makePair()
    fs.writeFileSync(path.join(src, 'keep.txt'), 'k')
    fs.mkdirSync(dst, { recursive: true })
    fs.writeFileSync(path.join(dst, 'keep.txt'), 'k')
    // 目标 20 项、待删 19 项 → 95% 且 ≥ SYNC_MIRROR_RATIO_MIN_COUNT，触发比例阈值
    for (let i = 0; i < 19; i++) fs.writeFileSync(path.join(dst, `stale${i}.txt`), 'x')

    const result = copySyncDirectory(src, dst, { mirror: true })

    expect(result.deleteAborted).toBe(true)
    expect(result.deleted).toBe(0)
    expect(fs.existsSync(path.join(dst, 'stale0.txt'))).toBe(true)
  })

  it('mirror：小目录不套用比例阈值，正常删除', () => {
    const { src, dst } = makePair()
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')
    fs.mkdirSync(dst, { recursive: true })
    fs.writeFileSync(path.join(dst, 'a.txt'), 'a')
    fs.writeFileSync(path.join(dst, 'stale.txt'), 'x')

    const result = copySyncDirectory(src, dst, { mirror: true })

    expect(result.deleteAborted).toBe(false)
    expect(result.deleted).toBe(1)
    expect(fs.existsSync(path.join(dst, 'stale.txt'))).toBe(false)
  })

  // ── 批量删除确认：指纹绑定（2026-09-16 远端清空事故的回归防护） ──────────

  it('mirror：超阈值删除连续两次都被挡下 —— 绝不自动放行', () => {
    const { src, dst } = makePair()
    fs.mkdirSync(dst, { recursive: true })
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dst, `f${i}.txt`), 'x')

    // 旧实现：第一次挡下后置位布尔，第二次同步即自动放行 —— 事故由此而来。
    // 现在无论同步多少次，没有匹配指纹就永远挡下。
    const first = copySyncDirectory(src, dst, { mirror: true, maxDeletes: 3 })
    expect(first.deleteAborted).toBe(true)
    expect(first.deleted).toBe(0)

    const second = copySyncDirectory(src, dst, { mirror: true, maxDeletes: 3 })
    expect(second.deleteAborted).toBe(true)
    expect(second.deleted).toBe(0)

    const third = copySyncDirectory(src, dst, { mirror: true, maxDeletes: 3 })
    expect(third.deleteAborted).toBe(true)
    expect(third.deleted).toBe(0)
  })

  it('mirror：挡下时返回待删集合指纹与条目数（供用户确认）', () => {
    const { src, dst } = makePair()
    fs.mkdirSync(dst, { recursive: true })
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dst, `f${i}.txt`), 'x')

    const blocked = copySyncDirectory(src, dst, { mirror: true, maxDeletes: 3 })

    expect(blocked.deleteAborted).toBe(true)
    expect(blocked.abortedFingerprint).toBeTruthy()
    expect(blocked.abortedCount).toBe(5)
  })

  it('mirror：confirmedFingerprint 匹配时放行（用户显式确认的那一批）', () => {
    const { src, dst } = makePair()
    fs.mkdirSync(dst, { recursive: true })
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dst, `f${i}.txt`), 'x')

    const blocked = copySyncDirectory(src, dst, { mirror: true, maxDeletes: 3 })
    expect(blocked.deleteAborted).toBe(true)

    const confirmed = copySyncDirectory(src, dst, {
      mirror: true,
      maxDeletes: 3,
      confirmedFingerprint: blocked.abortedFingerprint,
    })

    expect(confirmed.deleteAborted).toBe(false)
    expect(confirmed.deleted).toBe(5)
  })

  it('mirror：待删集合变化后指纹不匹配，确认自动失效', () => {
    const { src, dst } = makePair()
    fs.mkdirSync(dst, { recursive: true })
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dst, `f${i}.txt`), 'x')

    const blocked = copySyncDirectory(src, dst, { mirror: true, maxDeletes: 3 })

    // 确认前集合又变了（多了一个待删项）——用户确认的是旧的那一批，不该生效
    fs.writeFileSync(path.join(dst, 'extra.txt'), 'x')

    const stale = copySyncDirectory(src, dst, {
      mirror: true,
      maxDeletes: 3,
      confirmedFingerprint: blocked.abortedFingerprint,
    })

    expect(stale.deleteAborted).toBe(true)
    expect(stale.deleted).toBe(0)
    expect(fs.existsSync(path.join(dst, 'f0.txt'))).toBe(true)
  })

  it('computeStaleFingerprint：与顺序无关，集合变化则指纹变化', () => {
    const a = computeStaleFingerprint(['b.txt', 'a.txt'])
    const b = computeStaleFingerprint(['a.txt', 'b.txt'])
    const c = computeStaleFingerprint(['a.txt', 'c.txt'])

    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  // ── 增量短路：size + mtime 未变则跳过复制 ──────────────────────────────

  it('skipUnchanged：默认关闭，每次都复制', () => {
    const { src, dst } = makePair()
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')

    const first = copySyncDirectory(src, dst)
    expect(first.copied).toBe(1)
    expect(first.skippedUnchanged).toBe(0)

    const second = copySyncDirectory(src, dst)
    expect(second.copied).toBe(1)
    expect(second.skippedUnchanged).toBe(0)
  })

  it('skipUnchanged：复制后目标 mtime 被回写，第二遍跳过复制', () => {
    const { src, dst } = makePair()
    const srcFile = path.join(src, 'a.txt')
    fs.writeFileSync(srcFile, 'a')
    // 固定 mtime，避免测试机时间精度抖动带来假失败
    const fixed = new Date('2026-09-17T10:00:00Z')
    fs.utimesSync(srcFile, fixed, fixed)

    const first = copySyncDirectory(src, dst, { skipUnchanged: true })
    expect(first.copied).toBe(1)
    expect(first.skippedUnchanged).toBe(0)

    // 关键：不回写 mtime 的话下一轮比对永不相等，短路等于没写
    const dstStat = fs.statSync(path.join(dst, 'a.txt'))
    expect(dstStat.mtimeMs).toBe(fs.statSync(srcFile).mtimeMs)

    const second = copySyncDirectory(src, dst, { skipUnchanged: true })
    expect(second.copied).toBe(0)
    expect(second.skippedUnchanged).toBe(1)
  })

  it('skipUnchanged：等长改写（仅 mtime 变）会重新复制', () => {
    const { src, dst } = makePair()
    const srcFile = path.join(src, 'a.txt')
    fs.writeFileSync(srcFile, 'a')
    copySyncDirectory(src, dst, { skipUnchanged: true })

    // 内容等长 —— 只有 mtime 能区分，这正是 size 单条件不够的原因
    fs.writeFileSync(srcFile, 'b')
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(srcFile, later, later)

    const again = copySyncDirectory(src, dst, { skipUnchanged: true })
    expect(again.copied).toBe(1)
    expect(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8')).toBe('b')
  })

  it('skipUnchanged：源 mtime 带亚毫秒精度时仍能短路（utimesSync 舍入回归）', () => {
    // 真实故障场景（2026-09-17）：源文件 mtime 是 NTFS 100ns 精度（带小数），
    // utimesSync 回写后读回被舍入到整数 ms —— 严格比较永远不等，短路永不生效。
    const { src, dst } = makePair()
    const srcFile = path.join(src, 'a.bin')
    fs.writeFileSync(srcFile, 'x')
    fs.utimesSync(srcFile, 1789142563.4877817, 1789142563.4877817)

    const first = copySyncDirectory(src, dst, { skipUnchanged: true })
    expect(first.copied).toBe(1)

    const second = copySyncDirectory(src, dst, { skipUnchanged: true })
    expect(second.copied).toBe(0)
    expect(second.skippedUnchanged).toBe(1)
  })

  it('skipUnchanged：长度变化（仅 size 变）会重新复制', () => {
    const { src, dst } = makePair()
    const srcFile = path.join(src, 'a.txt')
    const fixed = new Date('2026-09-17T10:00:00Z')
    fs.writeFileSync(srcFile, 'aa')
    fs.utimesSync(srcFile, fixed, fixed)
    copySyncDirectory(src, dst, { skipUnchanged: true })

    // 只改长度、把 mtime 按回原值 —— 只剩 size 能区分
    fs.writeFileSync(srcFile, 'aaa')
    fs.utimesSync(srcFile, fixed, fixed)

    const again = copySyncDirectory(src, dst, { skipUnchanged: true })
    expect(again.copied).toBe(1)
    expect(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8')).toBe('aaa')
  })

  it('mirror：源侧大文件被跳过时，目标侧同名文件不被误删', () => {
    const { src, dst } = makePair()
    fs.writeFileSync(path.join(src, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 1))
    fs.mkdirSync(dst, { recursive: true })
    fs.writeFileSync(path.join(dst, 'big.bin'), 'old-version')

    const result = copySyncDirectory(src, dst, {
      mirror: true,
      maxSize: SYNC_OUTPUTS_MAX_BYTES,
    })

    expect(result.skippedLarge).toBe(1)
    expect(result.deleted).toBe(0)
    expect(fs.readFileSync(path.join(dst, 'big.bin'), 'utf8')).toBe('old-version')
  })
})
