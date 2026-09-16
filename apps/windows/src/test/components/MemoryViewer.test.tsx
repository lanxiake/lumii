/**
 * MemoryViewer：工作记忆的 Agent 筛选与来源徽标
 *
 * 记忆列表是全量跨 Agent 返回的（`agent:memories:list` 不传 sessionKey/agentId），
 * 界面必须让「这条是谁记的」可见——否则「按 Agent 隔离」只是提示词里的一句话，
 * 用户既验证不了隔离，也看不出某个 Agent 到底有没有积累。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  MemoryViewer,
  normalizeMemoryAgentId,
} from '../../renderer/pages/SettingsPage/components/MemoryViewer/MemoryViewer'

/**
 * hook 的返回值必须**引用稳定**：MemoryViewer 的 `load` 是
 * `useCallback(..., [listMemories])`，effect 又依赖 `load`——每次渲染给新函数
 * 会让 effect 反复触发，测试里表现为无限重渲染。
 */
const mocks = vi.hoisted(() => {
  const state = {
    memories: [] as Array<Record<string, unknown>>,
    agents: [] as Array<{ id: string; name: string }>,
  }
  return {
    state,
    listMemories: async () => state.memories,
    getAgents: async () => ({ agents: state.agents, total: state.agents.length }),
  }
})

vi.mock('../../renderer/hooks/business/useMemoryUsage', () => ({
  useMemoryUsage: () => ({
    listMemories: mocks.listMemories,
    deleteMemory: async () => true,
    updateMemory: async () => true,
    clearAll: async () => 0,
    exportJson: async () => '[]',
    getProvenance: async () => null,
    loading: false,
  }),
}))

vi.mock('../../renderer/services/agent-service', () => ({
  getAgents: mocks.getAgents,
}))

vi.mock('../../renderer/components/ui/Toast/useToast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    showToast: vi.fn(),
    hideToast: vi.fn(),
    hideAllToasts: vi.fn(),
  }),
}))

vi.mock('../../renderer/services/clipboard-service', () => ({
  writeClipboardText: async () => true,
}))

function memory(over: { id: string; agentId: string; content: string }): Record<string, unknown> {
  return {
    id: over.id,
    category: 'general',
    content: over.content,
    importance: 0.6,
    createdAt: Date.now(),
    sourceSegmentId: null,
    palaceDrawerId: null,
    agentId: over.agentId,
  }
}

describe('normalizeMemoryAgentId', () => {
  it('main / default / 缺省都归一到 assistant，其余原样', () => {
    expect(normalizeMemoryAgentId('main')).toBe('assistant')
    expect(normalizeMemoryAgentId('default')).toBe('assistant')
    expect(normalizeMemoryAgentId(undefined)).toBe('assistant')
    expect(normalizeMemoryAgentId('code-dev')).toBe('code-dev')
  })
})

describe('MemoryViewer 的 Agent 维度', () => {
  beforeEach(() => {
    mocks.state.agents = [
      { id: 'assistant', name: '系统默认' },
      { id: 'code-dev', name: '灵栖开发' },
    ]
    mocks.state.memories = [
      memory({ id: 'm1', agentId: 'assistant', content: '主助手记的项目进展' }),
      memory({ id: 'm2', agentId: 'code-dev', content: '开发记的排查结论' }),
    ]
  })

  it('多 Agent 时渲染筛选条，条数按归属统计', async () => {
    render(<MemoryViewer />)
    expect(await screen.findByRole('button', { name: '全部（2）' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '系统默认（1）' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '灵栖开发（1）' })).toBeInTheDocument()
  })

  it('筛到单个 Agent 后只剩它的记忆', async () => {
    render(<MemoryViewer />)
    await screen.findByText('主助手记的项目进展')

    fireEvent.click(screen.getByRole('button', { name: '灵栖开发（1）' }))

    await waitFor(() => expect(screen.queryByText('主助手记的项目进展')).not.toBeInTheDocument())
    expect(screen.getByText('开发记的排查结论')).toBeInTheDocument()
  })

  it('「全部」视图逐条标出来源，筛到单 Agent 后收起徽标', async () => {
    render(<MemoryViewer />)
    // 徽标文本不带条数后缀，getByText 的精确匹配只命中徽标、不命中筛选按钮
    expect(await screen.findByText('系统默认')).toBeInTheDocument()
    expect(screen.getByText('灵栖开发')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '系统默认（1）' }))

    await waitFor(() => expect(screen.queryByText('灵栖开发')).not.toBeInTheDocument())
    // 筛到具体 Agent 后整列同源，徽标一并收起；「系统默认」只剩筛选按钮里带条数的那份
    expect(screen.queryByText('系统默认')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '系统默认（1）' })).toBeInTheDocument()
  })

  it('只有一个归属 Agent 时不渲染筛选条', async () => {
    mocks.state.memories = [memory({ id: 'm1', agentId: 'assistant', content: '只有主助手的记忆' })]
    render(<MemoryViewer />)
    await screen.findByText('只有主助手的记忆')
    expect(screen.queryByRole('button', { name: /^全部（/ })).not.toBeInTheDocument()
  })

  it('归属为 main 的记忆归到系统默认名下，不单列一项', async () => {
    mocks.state.memories = [
      memory({ id: 'm1', agentId: 'main', content: '内部标记写下的记忆' }),
      memory({ id: 'm2', agentId: 'code-dev', content: '开发记的排查结论' }),
      memory({ id: 'm3', agentId: 'assistant', content: '主助手记的项目进展' }),
    ]
    render(<MemoryViewer />)
    expect(await screen.findByRole('button', { name: '系统默认（2）' })).toBeInTheDocument()
  })
})
