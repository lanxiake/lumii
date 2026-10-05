import { describe, expect, it } from 'vitest'
import { isNoReplySentinel } from './no-reply-sentinel'

describe('isNoReplySentinel', () => {
  it('命中纯哨兵（含首尾空白与大小写差异）', () => {
    expect(isNoReplySentinel('NO_REPLY')).toBe(true)
    expect(isNoReplySentinel('\n\nNO_REPLY')).toBe(true)
    expect(isNoReplySentinel(' no_reply ')).toBe(true)
  })

  it('正常正文/哨兵夹带其它内容一律不命中', () => {
    expect(isNoReplySentinel('好的，这就去办')).toBe(false)
    expect(isNoReplySentinel('NO_REPLY，已发飞书')).toBe(false)
    expect(isNoReplySentinel('')).toBe(false)
    expect(isNoReplySentinel(undefined)).toBe(false)
  })
})
