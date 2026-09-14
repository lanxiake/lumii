import { describe, it, expect } from 'vitest'
import { isPlaceholderAgentLabel, resolveBackfilledAgentLabel } from './sub-agent-label'

const INSTANCE_ID = 'agent-1789346095555-cyffjt'

describe('isPlaceholderAgentLabel', () => {
  it('空值与实例 id 视为占位', () => {
    expect(isPlaceholderAgentLabel('', INSTANCE_ID)).toBe(true)
    expect(isPlaceholderAgentLabel('   ', INSTANCE_ID)).toBe(true)
    expect(isPlaceholderAgentLabel(INSTANCE_ID, INSTANCE_ID)).toBe(true)
  })

  it('运行时生成的实例 id / 用户 Agent id 视为占位', () => {
    expect(isPlaceholderAgentLabel('agent-1789346096237-u4afme', INSTANCE_ID)).toBe(true)
    expect(isPlaceholderAgentLabel('user-1757000000000-abc123', INSTANCE_ID)).toBe(true)
  })

  it('内置定义 id 被当成名字时视为占位', () => {
    expect(isPlaceholderAgentLabel('default', INSTANCE_ID)).toBe(true)
    expect(isPlaceholderAgentLabel('assistant', INSTANCE_ID)).toBe(true)
    expect(isPlaceholderAgentLabel('builtin:explore', INSTANCE_ID)).toBe(true)
  })

  it('真实显示名不是占位', () => {
    expect(isPlaceholderAgentLabel('系统默认', INSTANCE_ID)).toBe(false)
    expect(isPlaceholderAgentLabel('灵栖维护', INSTANCE_ID)).toBe(false)
    expect(isPlaceholderAgentLabel('竞品调研员', INSTANCE_ID)).toBe(false)
  })
})

describe('resolveBackfilledAgentLabel', () => {
  it('占位 label 被真实名回填（原有竞态修复能力保留）', () => {
    expect(resolveBackfilledAgentLabel(INSTANCE_ID, INSTANCE_ID, '灵栖维护')).toBe('灵栖维护')
    expect(resolveBackfilledAgentLabel('', INSTANCE_ID, '系统默认')).toBe('系统默认')
  })

  it('已落库的真实名绝不被覆盖（本次修复的核心）', () => {
    // 用户自建 Agent：落库 label 是定义侧的真名，快照名却是 user-… 编码 id
    expect(
      resolveBackfilledAgentLabel('我的调研助手', 'agent-1789346095555-cyffjt', 'user-1757000000000-abc123'),
    ).toBeNull()
  })

  it('快照名自身是占位值时不回填', () => {
    expect(resolveBackfilledAgentLabel(INSTANCE_ID, INSTANCE_ID, 'user-1757000000000-abc123')).toBeNull()
    expect(resolveBackfilledAgentLabel(INSTANCE_ID, INSTANCE_ID, 'default')).toBeNull()
  })

  it('快照名缺失或与当前值相同 → 不变更', () => {
    expect(resolveBackfilledAgentLabel(INSTANCE_ID, INSTANCE_ID, undefined)).toBeNull()
    expect(resolveBackfilledAgentLabel(INSTANCE_ID, INSTANCE_ID, '   ')).toBeNull()
    expect(resolveBackfilledAgentLabel('灵栖维护', INSTANCE_ID, '灵栖维护')).toBeNull()
  })

  it('内置 id 作为 label 时可被真实名纠正', () => {
    expect(resolveBackfilledAgentLabel('builtin:explore', INSTANCE_ID, 'Explore (代码探索)')).toBe(
      'Explore (代码探索)',
    )
  })
})
