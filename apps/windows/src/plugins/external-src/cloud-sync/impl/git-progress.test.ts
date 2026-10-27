/**
 * git --progress 行解析单测。
 */
import { describe, expect, it } from 'vitest'
import { parseGitProgressChunk, parseGitProgressLine, parseGitSizeToken } from './git-progress'

describe('parseGitSizeToken', () => {
  it('解析 MiB / GiB', () => {
    expect(parseGitSizeToken('12.50 MiB')).toBe(Math.round(12.5 * 1024 * 1024))
    expect(parseGitSizeToken('2.90 GiB')).toBe(Math.round(2.9 * 1024 ** 3))
  })

  it('无法识别时返回 undefined', () => {
    expect(parseGitSizeToken('abc')).toBeUndefined()
    expect(parseGitSizeToken('')).toBeUndefined()
  })
})

describe('parseGitProgressLine', () => {
  it('解析 Receiving objects 完整行（含速度与体积）', () => {
    const p = parseGitProgressLine(
      'Receiving objects:  45% (1234/2700), 12.50 MiB | 2.10 MiB/s',
      'download',
    )
    expect(p).not.toBeNull()
    expect(p!.direction).toBe('download')
    expect(p!.phase).toBe('Receiving objects')
    expect(p!.percent).toBe(45)
    expect(p!.transferredBytes).toBe(Math.round(12.5 * 1024 * 1024))
    expect(p!.speedBytesPerSec).toBe(Math.round(2.1 * 1024 * 1024))
    expect(p!.totalBytes).toBeGreaterThan(p!.transferredBytes!)
    expect(p!.etaSeconds).toBeGreaterThan(0)
  })

  it('解析 Writing objects（上传）', () => {
    const p = parseGitProgressLine(
      'Writing objects: 100% (1320/1320), 5.20 MiB | 1.50 MiB/s, done.',
      'upload',
    )
    expect(p!.direction).toBe('upload')
    expect(p!.percent).toBe(100)
    expect(p!.totalBytes).toBe(p!.transferredBytes)
    expect(p!.etaSeconds).toBeUndefined()
  })

  it('非进度行返回 null', () => {
    expect(parseGitProgressLine('From https://gitcode.com/x/y', 'download')).toBeNull()
    expect(parseGitProgressLine('fatal: unable to access', 'download')).toBeNull()
  })
})

describe('parseGitProgressChunk', () => {
  it('同一 chunk 多段 \\r 刷新时取最后一段', () => {
    const chunk =
      'Receiving objects:  10% (100/1000), 1.00 MiB | 1.00 MiB/s\r' +
      'Receiving objects:  50% (500/1000), 5.00 MiB | 2.00 MiB/s\r'
    const p = parseGitProgressChunk(chunk, 'download')
    expect(p!.percent).toBe(50)
    expect(p!.transferredBytes).toBe(Math.round(5 * 1024 * 1024))
  })
})
