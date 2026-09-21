/**
 * provider-config 规范化工具的单元测试
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeAllowedModelIds,
  normalizeModelReasoning,
  normalizeThinkingFormat,
  reconcileModelIdWithAllowlist,
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

describe('reconcileModelIdWithAllowlist', () => {
  /**
   * 这条是回归防线：旧实现把「不在 allowlist 里的 modelId」**静默改回 allowlist[0]**，
   * 于是 image 槽（当时只给用户改 modelId 的入口）改完保存弹回原值，看起来像点了没反应。
   * 用户明确选了哪个模型，就不该被配置顺手丢掉。
   */
  it('modelId 不在 allowlist 时并入，而不是被打回第一项', () => {
    expect(reconcileModelIdWithAllowlist('nano-banana-2', ['gpt-image-2'])).toEqual({
      modelId: 'nano-banana-2',
      allowedModelIds: ['gpt-image-2', 'nano-banana-2'],
    })
  })

  it('已在 allowlist 内时原样返回（不动顺序）', () => {
    expect(reconcileModelIdWithAllowlist('b', ['a', 'b', 'c'])).toEqual({
      modelId: 'b',
      allowedModelIds: ['a', 'b', 'c'],
    })
  })

  it('modelId 为空时取 allowlist 第一项', () => {
    expect(reconcileModelIdWithAllowlist('', ['a', 'b'])).toEqual({
      modelId: 'a',
      allowedModelIds: ['a', 'b'],
    })
  })

  it('两边都空时保持为空', () => {
    expect(reconcileModelIdWithAllowlist('', [])).toEqual({ modelId: '', allowedModelIds: [] })
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
