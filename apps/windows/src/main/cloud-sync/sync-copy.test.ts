/**
 * sync-copy 单元测试：跳过 .git、5MB 大文件阈值、单文件复制失败不阻断。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SYNC_OUTPUTS_MAX_BYTES,
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
})
