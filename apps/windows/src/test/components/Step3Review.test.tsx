/**
 * Step3Review：左列表 + 右详情
 *
 * 覆盖：角色列表切换、技能/能力/MCP 勾选态来自 AI 推荐、移除角色。
 * 创建链路（fork/update）不在这里跑，由主流程手工验证覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Step3Review } from '../../renderer/pages/AgentsPage/components/GenerateTeamWizard/Step3Review'
import type {
  GeneratedAgent,
  CapabilityOption,
  McpServerOption,
} from '../../renderer/pages/AgentsPage/components/GenerateTeamWizard/types'

function makeAgent(overrides: Partial<GeneratedAgent> = {}): GeneratedAgent {
  return {
    name: '内容主编',
    emoji: '🧭',
    groupId: 'g1',
    groupName: '内容创作组',
    groupRole: 'coordinator',
    description: '定选题与编排',
    systemPrompt: '你是内容主编',
    capabilities: ['web_search'],
    skills: ['weather'],
    whenToUse: '需要定选题时',
    triggerExamples: ['帮我定个选题'],
    bundledSkills: [],
    mcpServers: ['excel-mcp'],
    ...overrides,
  }
}

const capabilityOptions: CapabilityOption[] = [
  { id: 'web_search', label: '联网搜索', description: '搜索最新信息', toolNames: ['web_search'] },
  { id: 'exec', label: '执行命令', description: '运行程序', toolNames: ['bash'] },
]

const mcpServers: McpServerOption[] = [
  { name: 'excel-mcp', tools: ['mcp__excel-mcp__read_excel'], connected: true },
  { name: 'mcp-trends-hub', tools: ['mcp__mcp-trends-hub__hot'], connected: true },
]

function renderStep(agents: GeneratedAgent[]) {
  return render(
    <Step3Review
      agents={agents}
      capabilityOptions={capabilityOptions}
      systemAgents={[{ id: 'assistant', name: '系统默认' }]}
      userSkills={[
        { id: 'weather', name: '天气查询' },
        { id: 'docx', name: 'Word 文档' },
      ]}
      mcpServers={mcpServers}
      onBack={vi.fn()}
      onComplete={vi.fn()}
    />,
  )
}

describe('Step3Review 角色确认页', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    ;(window as any).electronAPI = {}
  })

  it('左列表列出全部角色，右栏默认展示第一个', () => {
    renderStep([
      makeAgent(),
      makeAgent({ name: '撰稿编辑', emoji: '✂️', groupName: '内容创作组' }),
      makeAgent({ name: '校对专家', emoji: '🔍', groupName: '质控组' }),
    ])

    // 左列表三个角色 + 右栏标题里的名称输入框
    expect(screen.getByDisplayValue('内容主编')).toBeInTheDocument()
    expect(screen.getByText('撰稿编辑')).toBeInTheDocument()
    expect(screen.getByText('校对专家')).toBeInTheDocument()
    expect(screen.getByText(/共 3 个/)).toBeInTheDocument()
  })

  it('点击左列表切换右栏到对应角色', () => {
    renderStep([makeAgent(), makeAgent({ name: '撰稿编辑', systemPrompt: '你是撰稿编辑' })])

    fireEvent.click(screen.getByText('撰稿编辑'))

    expect(screen.getByDisplayValue('撰稿编辑')).toBeInTheDocument()
    expect(screen.getByDisplayValue('你是撰稿编辑')).toBeInTheDocument()
  })

  it('技能 / 可用能力 / MCP 服务都是勾选列表，勾选态来自 AI 推荐', () => {
    renderStep([makeAgent()])

    const skillSection = screen.getByText('可用技能（该角色能调用的技能）').parentElement!
    expect(screen.getByText('可用能力（工具面）')).toBeInTheDocument()
    expect(screen.getByText('MCP 服务（外部系统的连接）')).toBeInTheDocument()
    expect(screen.getByText('常驻技能（启动即自动激活）')).toBeInTheDocument()

    // AI 推荐 weather → 勾上；未推荐的 docx → 不勾（技能名在「常驻技能」里也出现，需限定作用域）
    const weatherBox = within(within(skillSection).getByText('天气查询').closest('label')!).getByRole('checkbox')
    const docxBox = within(within(skillSection).getByText('Word 文档').closest('label')!).getByRole('checkbox')
    expect(weatherBox).toBeChecked()
    expect(docxBox).not.toBeChecked()

    // AI 推荐 excel-mcp → 勾上；未推荐的 mcp-trends-hub → 不勾（其工具会进黑名单）
    const excelBox = within(screen.getByText('excel-mcp').closest('label')!).getByRole('checkbox')
    const trendsBox = within(screen.getByText('mcp-trends-hub').closest('label')!).getByRole('checkbox')
    expect(excelBox).toBeChecked()
    expect(trendsBox).not.toBeChecked()
  })

  it('技能 / 能力 / MCP 勾选可手动切换', () => {
    renderStep([makeAgent()])

    const skillSection = screen.getByText('可用技能（该角色能调用的技能）').parentElement!
    const docxBox = within(within(skillSection).getByText('Word 文档').closest('label')!).getByRole('checkbox')
    fireEvent.click(docxBox)
    expect(docxBox).toBeChecked()

    const trendsBox = within(screen.getByText('mcp-trends-hub').closest('label')!).getByRole('checkbox')
    fireEvent.click(trendsBox)
    expect(trendsBox).toBeChecked()
  })

  it('AI 没给能力/MCP 时按全开兜底（否则未勾选 = 全部禁用）', () => {
    const agent = makeAgent()
    delete (agent as Partial<GeneratedAgent>).capabilities
    delete (agent as Partial<GeneratedAgent>).mcpServers
    renderStep([agent])

    expect(within(screen.getByText('联网搜索').closest('label')!).getByRole('checkbox')).toBeChecked()
    expect(within(screen.getByText('执行命令').closest('label')!).getByRole('checkbox')).toBeChecked()
    expect(within(screen.getByText('excel-mcp').closest('label')!).getByRole('checkbox')).toBeChecked()
    expect(within(screen.getByText('mcp-trends-hub').closest('label')!).getByRole('checkbox')).toBeChecked()
  })

  it('移除角色后从列表消失，计数同步更新', () => {
    renderStep([makeAgent(), makeAgent({ name: '撰稿编辑' })])

    // 右栏默认是第一个角色，移除的是它
    fireEvent.click(screen.getByText('移除这个角色'))

    expect(screen.getByText(/共 1 个/)).toBeInTheDocument()
    expect(screen.queryByText('内容主编')).not.toBeInTheDocument()
    // 剩下的角色仍在列表，并自动成为右栏当前项
    expect(screen.getByText('撰稿编辑')).toBeInTheDocument()
    expect(screen.getByDisplayValue('撰稿编辑')).toBeInTheDocument()
  })

  it('触发例子按行编辑，输入换行不会被吞掉', () => {
    renderStep([makeAgent({ triggerExamples: ['帮我定个选题'] })])

    const find = () =>
      screen.getByPlaceholderText('每行一个用户可能说的原话') as HTMLTextAreaElement
    expect(find().value).toBe('帮我定个选题')

    fireEvent.change(find(), { target: { value: '帮我定个选题\n再来一个' } })

    expect(find().value).toBe('帮我定个选题\n再来一个')
  })
})
