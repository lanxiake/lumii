/**
 * DetailPanel：内置 Agent 定义详情展示
 *
 * 覆盖用户能看到的四件事：何时使用 / 能力配置（工具白话分组 + 技能）/ 运行方式 / 边界。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DetailPanel } from '../../renderer/pages/AgentsPage/views/DetailPanel'
import type { Agent } from '../../renderer/pages/AgentsPage/views/types'

type Binding = { agentId: string; backendId: string; workspace?: string; enabled: boolean }

function mockElectronApi(bindings: Binding[] = []) {
  ;(window as any).electronAPI = {
    agentRuntime: {
      getLifecycleSnapshot: vi.fn(async () => ({
        instanceCount: 0,
        runningCount: 0,
        anyRunning: false,
        runningSinceMs: null,
        totalTurns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        subAgentsRunning: 0,
      })),
    },
    app: {
      getCodingDevAgentBindings: vi.fn(async () => bindings),
    },
    autonomous: {
      getAgents: vi.fn(async () => []),
      setAgents: vi.fn(async () => ({ ok: true })),
    },
  }
}

/** 内置「灵栖开发」：工具面 + 边界来自 definition */
const codeDevAgent: Agent = {
  id: 'code-dev',
  name: '灵栖开发',
  description: 'Bind a project and complete verifiable code changes in it.',
  systemPrompt: '你是「灵栖开发」…',
  modelTier: 'balanced',
  definition: {
    tools: ['bash', 'file_read', 'glob', 'grep', 'file_edit', 'wiki_search', 'todo_write'],
    maxTurns: 80,
    canSpawnSubAgents: false,
    memoryScope: 'user',
    permissionMode: 'readOnly',
  },
}

const noop = () => undefined

function renderPanel(agent: Agent, bindings: Binding[] = []) {
  mockElectronApi(bindings)
  return render(
    <DetailPanel
      agent={agent}
      isSystem={!agent.userId}
      onClose={noop}
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

    // 工具：按白话标签聚合，原始名进 title 供悬停查看
    const capabilitySection = screen.getByText('能力配置')
    expect(capabilitySection).toBeInTheDocument()
    const fileChip = screen.getByTitle('file_read、glob、grep')
    expect(fileChip).toHaveTextContent('读取文件')
    expect(fileChip).toHaveTextContent('3')
    expect(screen.getByText('执行命令')).toBeInTheDocument()
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

  it('app_* 工具合并为客户端界面两档，悬停可看原始名', () => {
    renderPanel({
      id: 'system-keeper',
      name: '灵栖维护',
      description: '维护知识资产并代操客户端',
      definition: {
        tools: ['app_screenshot', 'app_goto_and_screenshot', 'app_act', 'app_fill_form'],
      },
    })

    // 查看界面 2 个合并；操作界面 2 个合并
    expect(screen.getByTitle('app_screenshot、app_goto_and_screenshot')).toHaveTextContent('查看客户端界面')
    expect(screen.getByTitle('app_act、app_fill_form')).toHaveTextContent('操作客户端界面')
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
})
