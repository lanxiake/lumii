/**
 * SRT 生成单测
 */
import { describe, expect, it } from 'vitest'
import { cuesToSrt, formatSrtTimestamp } from './srt'

describe('formatSrtTimestamp', () => {
  it('格式化为 HH:MM:SS,mmm', () => {
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000')
    expect(formatSrtTimestamp(3661_234)).toBe('01:01:01,234')
  })
})

describe('cuesToSrt', () => {
  it('生成标准多条 SRT', () => {
    const srt = cuesToSrt([
      { startMs: 0, endMs: 1000, text: '你好' },
      { startMs: 1500, endMs: 2500, text: '世界' },
    ])
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,000\n你好')
    expect(srt).toContain('2\n00:00:01,500 --> 00:00:02,500\n世界')
    expect(srt.endsWith('\n')).toBe(true)
  })

  it('跳过空文本；end<=start 时补 1ms', () => {
    const srt = cuesToSrt([
      { startMs: 100, endMs: 50, text: '短' },
      { startMs: 0, endMs: 1, text: '   ' },
    ])
    expect(srt).toContain('00:00:00,100 --> 00:00:00,101\n短')
    expect(srt).not.toContain('2\n')
  })
})
