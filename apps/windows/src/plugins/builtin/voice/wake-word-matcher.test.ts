import { describe, expect, it } from 'vitest'
import { matchWakeWord } from './wake-word-matcher'

describe('唤醒词匹配「灵栖灵栖」', () => {
  it('标准说法命中', () => {
    expect(matchWakeWord('灵栖灵栖')).toBe('灵栖灵栖')
  })

  it('带标点、空格命中', () => {
    expect(matchWakeWord('灵栖，灵栖。')).toBe('灵栖灵栖')
    expect(matchWakeWord(' 灵栖 灵栖 ')).toBe('灵栖灵栖')
  })

  it('夹语气词命中', () => {
    expect(matchWakeWord('灵栖啊灵栖')).toBe('灵栖灵栖')
    expect(matchWakeWord('灵栖，嗯，灵栖')).toBe('灵栖灵栖')
  })

  it('同音误识仍命中（离线 ASR 对生造词不敏感）', () => {
    expect(matchWakeWord('林西林西')).toBe('灵栖灵栖')
    expect(matchWakeWord('灵息灵息')).toBe('灵栖灵栖')
    expect(matchWakeWord('凌溪凌溪')).toBe('灵栖灵栖')
  })

  it('前后有其它话也能命中', () => {
    expect(matchWakeWord('那个灵栖灵栖你在吗')).toBe('灵栖灵栖')
  })

  it('只说一遍不唤醒（避免误触）', () => {
    expect(matchWakeWord('灵栖')).toBeNull()
    expect(matchWakeWord('灵栖你好')).toBeNull()
  })

  it('无关注音不命中', () => {
    expect(matchWakeWord('你好')).toBeNull()
    expect(matchWakeWord('')).toBeNull()
    expect(matchWakeWord('今天天气如何')).toBeNull()
  })

  it('间距过远的两次不算连续重复', () => {
    expect(matchWakeWord('灵栖今天天气不错我想说的是灵栖')).toBeNull()
  })
})
