/**
 * DetailPanel：内置 Agent 定义详情展示
 *
 * 覆盖用户能看到的四件事：何时使用 / 能力配置（工具白话分组 + 技能）/ 运行方式 / 边界。
 * 面板已移除模型信息、运行状态与自主心跳开关，并支持点击面板外空白处关闭。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DetailPanel } from '../../renderer/pages/AgentsPage/views/DetailPanel'
import type { Agent } from '../../renderer/pages/AgentsPage/views/types'

type Binding = { agentId: string; backendId: string; workspace?: string; enabled: boolean }

function mockElectronApi(bindings: Binding[] = []) {
  ;(window as any).electronAPI = {
    app: {
      getCodingDevAgentBindings: vi.fn(async () => bindings),
    },
  }
}

/** 内置「灵栖开发」：工具面 + 边界来自 definition */
const codeDevAgent: Agent = {
  id: 'code-dev',
  name: '灵栖开发',
  description: 'Bind a project and complete verifiable code changes in it.',
  systemPrompt: '你是「灵栖开发」…',
  definition: {
    tools: ['bash', 'file_read', 'glob', 'grep', 'file_edit', 'wiki_search', 'todo_write'],
    maxTurns: 80,
    canSpawnSubAgents: false,
    memoryScope: 'user',
    permissionMode: 'readOnly',
  },
}

const noop = () => undefined

function renderPanel(agent: Agent, bindings: Binding[] = [], onClose: () => void = noop) {
  mockElectronApi(bindings)
  return render(
    <DetailPanel
      agent={agent}
      isSystem={!agent.userId}
      onClose={onClose}
      onStartChat={noop}
      onEdit={noop}
      onDelete={noop}
      onFork={noop}
    />,
  )
}

describe('DetailPanel 内置 Agent 详情', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('展示何时使用、工具白话分组与技能未限制', async () => {
    renderPanel(codeDevAgent)

    expect(screen.getByText('何时使用')).toBeInTheDocument()
    expect(
      screen.getByText('Bind a project and complete verifiable code changes in it.'),
    ).toBeInTheDocument()

    // 工具：白话标签旁直接列出原始工具名（不再依赖悬停）
    const capabilitySection = screen.getByText('能力配置')
    expect(capabilitySection).toBeInTheDocument()
    const fileChip = screen.getByText('读取文件')
    expect(fileChip).toHaveTextContent('file_read')
    expect(fileChip).toHaveTextContent('glob')
    expect(screen.getByText('执行命令')).toHaveTextContent('bash')
    expect(screen.getByText('资料库检索')).toBeInTheDocument()

    // 技能白名单为空 = 未限制
    expect(screen.getByText('未限制（全部已安装技能可用）')).toBeInTheDocument()

    // 边界（来自 definition）
    expect(screen.getByText(/跨会话长期记忆.*单次最多 80 轮.*不派生子 Agent.*只读/)).toBeInTheDocument()
  })

  it('tools=["*"] 展示为「全部工具」而非原始星号', () => {
    renderPanel({
      id: 'assistant',
      name: '系统默认',
      description: '通用入口',
      definition: { tools: ['*'] },
    })

    expect(screen.getByText('全部工具')).toBeInTheDocument()
  })

  it('app_* 工具合并为客户端界面两档，原始名并排展示', () => {
    renderPanel({
      id: 'system-keeper',
      name: '灵栖维护',
      description: '维护知识资产并代操客户端',
      definition: {
        tools: ['app_screenshot', 'app_goto_and_screenshot', 'app_act', 'app_fill_form'],
      },
    })

    // 查看界面 2 个合并；操作界面 2 个合并，原始名直接可见
    expect(screen.getByText('查看客户端界面')).toHaveTextContent('app_screenshot')
    expect(screen.getByText('查看客户端界面')).toHaveTextContent('app_goto_and_screenshot')
    expect(screen.getByText('操作客户端界面')).toHaveTextContent('app_act')
    expect(screen.getByText('操作客户端界面')).toHaveTextContent('app_fill_form')
  })

  it('绑定外部 CLI 时展示工具与工作目录；未绑定则说明走内置内核', async () => {
    renderPanel(codeDevAgent, [
      { agentId: 'code-dev', backendId: 'claude', workspace: 'E:\\my-project\\lumii', enabled: true },
    ])

    expect(await screen.findByText('外部 CLI')).toBeInTheDocument()
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    const workspace = screen.getByText('lumii')
    expect(workspace).toHaveAttribute('title', 'E:\\my-project\\lumii')
  })

  it('未绑定 CLI 的灵栖开发提示走内置内核', async () => {
    renderPanel(codeDevAgent)

    expect(await screen.findByText(/内置内核（未绑定外部 CLI/)).toBeInTheDocument()
  })

  it('用户 Agent 无 definition：工具面由能力开关反推，技能列出白名单', () => {
    renderPanel({
      id: 'user-1',
      userId: 'local-user',
      name: '我的助手',
      description: '自定义',
      skillBlacklist: ['web_search', 'web_fetch'],
      skillFilter: ['系统维护手册'],
      whenToUse: '写周报时使用',
    })

    expect(screen.getByText('写周报时使用')).toBeInTheDocument()
    // 联网能力被关掉，剩余能力仍展示
    expect(screen.getByText(/已关闭：联网搜索、访问网页/)).toBeInTheDocument()
    expect(screen.getByText('执行命令')).toBeInTheDocument()
    expect(screen.getByText('系统维护手册')).toBeInTheDocument()
    // 用户 Agent 不展示运行方式（未绑定 CLI）
    expect(screen.queryByText('运行方式')).not.toBeInTheDocument()
  })

  it('不再展示模型信息、运行状态与自主心跳开关', () => {
    renderPanel(codeDevAgent)

    expect(screen.queryByText('模型信息')).not.toBeInTheDocument()
    expect(screen.queryByText('模型级别')).not.toBeInTheDocument()
    expect(screen.queryByText('运行状态')).not.toBeInTheDocument()
    expect(screen.queryByText('自主能力')).not.toBeInTheDocument()
    expect(screen.queryByText('参与自主心跳')).not.toBeInTheDocument()
  })

  it('点击面板外空白处关闭，点击面板内部不关闭', () => {
    const onClose = vi.fn()
    const { container } = renderPanel(codeDevAgent, [], onClose)
    const overlay = container.firstElementChild as HTMLElement
    const panel = overlay.firstElementChild as HTMLElement

    fireEvent.click(panel)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
