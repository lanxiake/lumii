/**
 * 行级 diff 纯函数：插入/删除统计、hunk 上下文、空内容。
 */
import { describe, expect, it } from 'vitest'
import { diffText } from './text-diff'

describe('diffText', () => {
  it('统计插入/删除并保留上下文行', () => {
    const result = diffText('a\nb\nc\n', 'a\nB\nc\n')
    expect(result.insertions).toBe(1)
    expect(result.deletions).toBe(1)
    expect(result.hunks.length).toBe(1)
    const lines = result.hunks[0]!.lines
    expect(lines).toContain('-b')
    expect(lines).toContain('+B')
    expect(lines).toContain(' a')
  })

  it('空内容与纯新增', () => {
    expect(diffText('', '')).toMatchObject({ insertions: 0, deletions: 0, hunks: [] })
    const added = diffText('', 'hello\n')
    expect(added.insertions).toBe(1)
    expect(added.deletions).toBe(0)
  })
})
