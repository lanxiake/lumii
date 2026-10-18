import { describe, expect, it } from 'vitest'
import { buildSkillCommands, sortCommandsByUsage } from './slash-commands'

const skill = (overrides: Partial<{
  id: string
  dirName: string
  name: string
  description: string
  enabled: boolean
  executionCount: number
}> = {}) => ({
  id: 'weather',
  dirName: 'weather',
  name: '天气查询',
  description: '查询天气预报',
  enabled: true,
  ...overrides,
})

describe('buildSkillCommands', () => {
  it('把已开启技能转成 /命令，并保留技能 ID 与展示名', () => {
    const commands = buildSkillCommands([skill()], new Set())

    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      name: '/weather',
      category: 'skill',
      skillId: 'weather',
      skillName: '天气查询',
      usage: '/weather [需求]',
    })
  })

  it('跳过未开启的技能', () => {
    const commands = buildSkillCommands([skill({ enabled: false })], new Set())
    expect(commands).toHaveLength(0)
  })

  it('命令名取目录名并做 slug 化', () => {
    const commands = buildSkillCommands(
      [skill({ id: '创作/小红书 文案', dirName: '小红书写手', name: '小红书文案' })],
      new Set(),
    )
    expect(commands[0]?.name).toBe('/小红书写手')
  })

  it('与内置命令重名时自动加后缀，不覆盖内置语义', () => {
    const commands = buildSkillCommands([skill({ id: 'help', dirName: 'help' })], new Set(['/help']))
    expect(commands[0]?.name).toBe('/help-skill')
  })

  it('多个技能撞名时依次加序号', () => {
    const commands = buildSkillCommands(
      [
        skill({ id: 'a/help', dirName: 'help' }),
        skill({ id: 'b/help', dirName: 'help' }),
      ],
      new Set(['/help']),
    )
    expect(commands.map((c) => c.name)).toEqual(['/help-skill', '/help-skill-2'])
  })

  it('把技能的 executionCount 带进排序权重', () => {
    const commands = buildSkillCommands([skill({ executionCount: 7 })], new Set())
    expect(commands[0]?.usageCount).toBe(7)
  })
})

describe('sortCommandsByUsage', () => {
  const cmd = (name: string, usageCount?: number) => ({
    name,
    description: '',
    category: 'info' as const,
    usageCount,
  })

  it('使用次数多的排前面', () => {
    const sorted = sortCommandsByUsage([cmd('/a', 1), cmd('/b', 9), cmd('/c', 3)])
    expect(sorted.map((c) => c.name)).toEqual(['/b', '/c', '/a'])
  })

  it('次数相同（含都未使用）时按名称字母序', () => {
    const sorted = sortCommandsByUsage([cmd('/zoom'), cmd('/alpha'), cmd('/beta', 0)])
    expect(sorted.map((c) => c.name)).toEqual(['/alpha', '/beta', '/zoom'])
  })

  it('不修改传入数组', () => {
    const input = [cmd('/b', 1), cmd('/a', 2)]
    sortCommandsByUsage(input)
    expect(input.map((c) => c.name)).toEqual(['/b', '/a'])
  })
})
