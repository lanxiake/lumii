/**
 * provider-config 规范化工具的单元测试
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeAllowedModelIds,
  normalizeModelReasoning,
  normalizeThinkingFormat,
} from './provider-config'

describe('normalizeAllowedModelIds', () => {
  it('空 allowlist 时回退到 modelId', () => {
    expect(normalizeAllowedModelIds(undefined, 'deepseek-v4-flash')).toEqual(['deepseek-v4-flash'])
    expect(normalizeAllowedModelIds([], 'a')).toEqual(['a'])
  })

  it('去重并去掉空白', () => {
    expect(normalizeAllowedModelIds([' a ', 'b', 'a', ''], 'x')).toEqual(['a', 'b'])
  })

  it('无 modelId 且无 allowlist 时返回空数组', () => {
    expect(normalizeAllowedModelIds([], '')).toEqual([])
    expect(normalizeAllowedModelIds(undefined, '  ')).toEqual([])
  })
})

describe('normalizeModelReasoning', () => {
  it('保留布尔值并修剪 key', () => {
    expect(normalizeModelReasoning({ ' qwen3-next ': true, b: false })).toEqual({
      'qwen3-next': true,
      b: false,
    })
  })

  it('丢弃非布尔值与空 key', () => {
    expect(normalizeModelReasoning({ a: 'yes', '': true, b: 1, c: null })).toEqual({})
  })

  it('非对象输入返回空对象（旧配置兼容）', () => {
    expect(normalizeModelReasoning(undefined)).toEqual({})
    expect(normalizeModelReasoning('x')).toEqual({})
  })
})

describe('normalizeThinkingFormat', () => {
  it('接受四个合法值', () => {
    expect(normalizeThinkingFormat('auto')).toBe('auto')
    expect(normalizeThinkingFormat('openai')).toBe('openai')
    expect(normalizeThinkingFormat('qwen')).toBe('qwen')
    expect(normalizeThinkingFormat('zai')).toBe('zai')
  })

  it('非法值返回 undefined，由调用方回退', () => {
    expect(normalizeThinkingFormat('deepseek')).toBeUndefined()
    expect(normalizeThinkingFormat(undefined)).toBeUndefined()
  })
})
