/**
 * provider-config 规范化工具的单元测试
 */
import { describe, expect, it } from 'vitest'
import { normalizeAllowedModelIds } from './provider-config'

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
