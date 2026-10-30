import { describe, expect, it } from 'vitest'
import type { SkillInfo } from '@mtbot/agent-runtime'
import { buildCapabilityInventory, type CapabilityInventoryInput } from './capability-inventory'

const tool = (name: string, description: string, parameters: unknown = { type: 'object' }) =>
  ({ name, label: name.toUpperCase(), description, parameters }) as never

const skill = (id: string, name: string, description: string, extra: Partial<SkillInfo> = {}) =>
  ({ id, name, description, location: `/skills/${id}/SKILL.md`, ...extra }) as SkillInfo

function input(over: Partial<CapabilityInventoryInput> = {}): CapabilityInventoryInput {
  return {
    tools: [],
    skills: [],
    usageByAgent: {},
    ...over,
  }
}

describe('buildCapabilityInventory', () => {
  it('工具成本走标定比，与 contextUsage 同口径', () => {
    const t = tool('bash', 'Run a shell command.')
    // toolText = name + description + JSON.stringify(parameters)
    const chars = 'bash'.length + 'Run a shell command.'.length + JSON.stringify({ type: 'object' }).length

    const [calibrated] = buildCapabilityInventory(
      input({ tools: [t], charsPerToken: 8 }),
    )
    expect(calibrated.residentTokens).toBe(Math.round(chars / 8))

    // 没标定值时必须与 estimateToolTokens 的权重法一致，而不是自己再算一套
    const [legacy] = buildCapabilityInventory(input({ tools: [t] }))
    expect(legacy.residentTokens).toBeGreaterThan(0)
    expect(legacy.residentTokens).not.toBe(calibrated.residentTokens)
  })

  it('工具用量跨 Agent 汇总，最后使用取最晚', () => {
    const rows = buildCapabilityInventory(
      input({
        tools: [tool('bash', 'Run a shell command.'), tool('file_read', 'Read a file.')],
        usageByAgent: {
          assistant: { bash: { count: 3, errorCount: 0, lastUsedAt: 100 } },
          chronicler: { bash: { count: 2, errorCount: 1, lastUsedAt: 900 } },
        },
      }),
    )
    const bash = rows.find((r) => r.id === 'bash')!
    expect(bash.usage30d).toBe(5)
    expect(bash.lastUsed).toBe(900)

    const read = rows.find((r) => r.id === 'file_read')!
    expect(read.usage30d).toBe(0)
    expect(read.lastUsed).toBeNull()
  })

  it('技能用量取 executionCount（累计），且没有最后使用时间', () => {
    const rows = buildCapabilityInventory(
      input({
        skills: [skill('wiki', 'Wiki', '查询与维护 wiki。', { usageCount: 7 })],
      }),
    )
    expect(rows[0]).toMatchObject({ kind: 'skill', id: 'wiki', usage30d: 7, lastUsed: null })
    expect(rows[0].residentTokens).toBeGreaterThan(0)
  })

  it('技能没有 usageCount 时按 0，不退回去查工具用量表（B1 坑）', () => {
    const rows = buildCapabilityInventory(
      input({
        skills: [skill('wiki', 'Wiki', '查询与维护 wiki。')],
        // 同名工具用量存在也不许兜底
        usageByAgent: { assistant: { wiki: { count: 99, errorCount: 0, lastUsedAt: 1 } } },
      }),
    )
    expect(rows[0].usage30d).toBe(0)
  })

  it('whenToUse：工具取描述首句，技能优先 when_to_use', () => {
    const rows = buildCapabilityInventory(
      input({
        tools: [tool('bash', 'Run a shell command. Supports pipes and redirection.')],
        skills: [skill('wiki', 'Wiki', '工具描述这里。', { whenToUse: '需要查资料时。' })],
      }),
    )
    expect(rows.find((r) => r.id === 'bash')!.whenToUse).toBe('Run a shell command.')
    expect(rows.find((r) => r.id === 'wiki')!.whenToUse).toBe('需要查资料时。')
  })

  it('技能没 when_to_use 时回落 description', () => {
    const [row] = buildCapabilityInventory(input({ skills: [skill('wiki', 'Wiki', '查询与维护 wiki。')] }))
    expect(row.whenToUse).toBe('查询与维护 wiki。')
  })

  it('id 缺失的技能用 name 兜底，不产空 id', () => {
    const [row] = buildCapabilityInventory(
      input({ skills: [skill(undefined as never, 'Wiki', '查询与维护 wiki。')] }),
    )
    expect(row.id).toBe('Wiki')
  })
})
