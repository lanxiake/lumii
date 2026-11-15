import { beforeAll, describe, expect, it } from 'vitest'
import { buildSkillCommands, loadSlashCommandsFromIpc, searchCommands, sortCommandsByUsage } from './slash-commands'

const skill = (overrides: Partial<{
  id: string
  dirName: string
  name: string
  description: string
  category: string
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

  it('保留未截断的描述供搜索，面板仍用截断版展示', () => {
    const long = `${'x'.repeat(70)} Word documents 关键词在截断点之后`
    const commands = buildSkillCommands([skill({ description: long })], new Set())
    expect(commands[0]?.description).toHaveLength(80)
    expect(commands[0]?.description.endsWith('…')).toBe(true)
    expect(commands[0]?.searchText).toBe(long)
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

/**
 * 搜索是用户唯一能在大堆技能里找到目标的入口，故按**真实技能元数据**验证，
 * 而不是造几条理想数据 —— 旧实现正是被理想数据「测过」才漏掉中文/拼音缺口。
 */
describe('searchCommands', () => {
  const REAL_SKILLS = [
    { id: 'weather', dirName: 'weather', name: 'weather', category: '', description: 'Get current weather and forecasts (no API key required).' },
    { id: '文档与分析/docx', dirName: 'docx', name: 'docx', category: '文档与分析', description: 'Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include any mention of "Word doc".' },
    { id: '内容创作与发布/xiaohongshu-content-pipeline', dirName: 'xiaohongshu-content-pipeline', name: 'xiaohongshu-content-pipeline', category: '内容创作与发布', description: '小红书内容创作与发布端到端编排技能。用于将讨论主题、研究搜集材料、编写大纲、生成笔记内容、生图/卡片、发布到小红书串成完整工作流' },
    { id: '视频创作/video-creation-pipeline', dirName: 'video-creation-pipeline', name: 'video-creation-pipeline', category: '视频创作', description: 'MiniMax H3 本地视频创作全流程编排技能。当用户要生成视频、制作短视频、图片转视频、优化视频提示词、剪辑合成视频时使用。' },
    { id: '语音与音频/qwen3-tts-local', dirName: 'qwen3-tts-local', name: 'qwen3-tts-local', category: '语音与音频', description: '真正的本地语音合成服务，使用 Edge-TTS 引擎，零依赖、零配置、完全离线可用' },
  ]

  const names = (query: string): string[] => searchCommands(query).map((c) => c.name)

  beforeAll(async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        agentRuntime: { sendCommand: async () => [] },
        skills: { listLocalInstalled: async () => ({ success: true, data: REAL_SKILLS }) },
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    }
    await loadSlashCommandsFromIpc()
  })

  it('命令名前缀', () => {
    expect(names('/docx')).toContain('/docx')
  })

  it('拼音全拼命中英文名技能', () => {
    expect(names('/shipin')).toEqual(expect.arrayContaining(['/video-creation-pipeline']))
  })

  it('拼音首字母命中', () => {
    expect(names('/xhs')).toEqual(['/xiaohongshu-content-pipeline'])
  })

  it('中文输入命中中文描述', () => {
    expect(names('/小红书')).toEqual(['/xiaohongshu-content-pipeline'])
  })

  it('中文输入经全拼命中拉丁名', () => {
    expect(names('/语音')).toContain('/qwen3-tts-local')
  })

  it('中文分类名命中该分类下所有技能', () => {
    expect(names('/文档')).toContain('/docx')
  })

  it('描述里的中文关键词可用拼音搜到（音节边界匹配）', () => {
    expect(names('/jianji')).toEqual(['/video-creation-pipeline'])
  })

  it('截断点之后的关键词仍可搜到', () => {
    // 「Word documents」在 80 字截断之外，旧实现搜不到
    expect(names('/word')).toEqual(['/docx'])
  })

  it('单字拼音不产生大面积噪声', () => {
    // 「画」→ hua，旧实现把单字母 h 当子串，命中 13 条无关命令
    const hits = names('/画')
    expect(hits.length).toBeLessThan(8)
  })

  it('命中按质量分级：命令名前缀排在描述命中之前', () => {
    const hits = names('/doc')
    expect(hits[0]).toBe('/docx')
  })
})
