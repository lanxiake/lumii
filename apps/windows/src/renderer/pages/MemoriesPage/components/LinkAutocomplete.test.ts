import { describe, expect, it } from 'vitest'
import { detectWikilinkTrigger } from './LinkAutocomplete'

describe('detectWikilinkTrigger', () => {
  it('检测到 [[ 后未闭合时返回已输入的查询文本', () => {
    expect(detectWikilinkTrigger('参见 [[微信')).toBe('微信')
    expect(detectWikilinkTrigger('参见 [[')).toBe('')
  })

  it('已闭合 ]] 时不触发', () => {
    expect(detectWikilinkTrigger('参见 [[微信]] 的逻辑')).toBeNull()
  })

  it('换行后不再触发（跨行不解析）', () => {
    expect(detectWikilinkTrigger('参见 [[微信\n语音')).toBeNull()
  })

  it('无 [[ 时不触发', () => {
    expect(detectWikilinkTrigger('普通文本')).toBeNull()
  })

  it('取最后一个未闭合的 [[', () => {
    expect(detectWikilinkTrigger('[[已闭合]] 然后 [[新的')).toBe('新的')
  })
})
