/**
 * textarea 选区（DOM 归一化 `\n`）→ 磁盘原文偏移。
 */
import { describe, expect, it } from 'vitest'
import { mapNormalizedSelectionToRaw } from './selection-range'

describe('mapNormalizedSelectionToRaw', () => {
  it('LF 文件：偏移原样返回', () => {
    expect(mapNormalizedSelectionToRaw('hello', 1, 3)).toEqual({
      start: 1,
      end: 3,
      text: 'el',
    })
  })

  it('CRLF 文件：按原文下标补偿，选区含换行也正确', () => {
    const content = 'a\r\nb\r\nc'
    // DOM 值：'a\nb\nc'
    expect(mapNormalizedSelectionToRaw(content, 2, 3)).toEqual({ start: 3, end: 4, text: 'b' })
    expect(mapNormalizedSelectionToRaw(content, 1, 3)).toEqual({
      start: 1,
      end: 4,
      text: '\nb',
    })
  })

  it('单独 CR 也按一个换行处理', () => {
    expect(mapNormalizedSelectionToRaw('a\rb', 2, 3)).toEqual({ start: 2, end: 3, text: 'b' })
  })

  it('越界/非法区间返回 null', () => {
    expect(mapNormalizedSelectionToRaw('abc', -1, 2)).toBeNull()
    expect(mapNormalizedSelectionToRaw('abc', 2, 1)).toBeNull()
    expect(mapNormalizedSelectionToRaw('abc', 0, 4)).toBeNull()
    expect(mapNormalizedSelectionToRaw('abc', 0.5, 1)).toBeNull()
  })
})
