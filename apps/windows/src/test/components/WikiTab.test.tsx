/**
 * WikiTab：空状态渲染、分类切换、搜索交互（mock window.electronAPI.agentRuntime.sendCommand）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WikiTab } from '../../renderer/pages/MemoriesPage/components/WikiTab'
import { WikiTaskCenter } from '../../renderer/pages/MemoriesPage/components/WikiTaskCenter'
import type { WikiLocalTask } from '../../renderer/pages/MemoriesPage/components/useWikiTaskCenter'

function mockSendCommand(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (cmd: { type: string }) => {
    if (cmd.type in overrides) return overrides[cmd.type]
    switch (cmd.type) {
      case 'wiki:page:list':
        return []
      case 'wiki:inbox:list':
        return []
      case 'wiki:inbox:count':
        return { total: 0 }
      case 'wiki:runs:list':
        return []
      default:
        return null
    }
  })
}

describe('WikiTab', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    ;(window as any).electronAPI = {
      agentRuntime: { sendCommand: mockSendCommand() },
    }
  })

  it('空状态默认显示资料列表说明，不生成示例数据', async () => {
    render(<WikiTab />)
    expect(await screen.findByText(/暂无页面/)).toBeInTheDocument()
  })

  it('切换到待整理分类显示对应空状态', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无页面/)
    fireEvent.click(screen.getByText('待整理'))
    await waitFor(() => {
      expect(screen.getByText(/暂无待整理条目/)).toBeInTheDocument()
    })
  })

  it('搜索关键词后展示搜索结果视图', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:search': [
        { pageId: 'p1', path: 'sources/arch', category: 'sources', title: '架构设计文档', snippet: '正文片段', updatedAt: Date.now() },
      ],
    })
    render(<WikiTab />)
    await screen.findByText(/暂无页面/)

    const input = screen.getByPlaceholderText('搜索 Wiki…')
    fireEvent.change(input, { target: { value: '架构设计' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByText('架构设计文档')).toBeInTheDocument()
    })
  })

  it('资料列表行显示分类、相对时间与路径', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:page:list': [
        {
          id: 'p1',
          path: 'sources/architecture.md',
          category: 'sources',
          title: '架构设计文档',
          version: 1,
          updatedAt: Date.now(),
        },
      ],
    })
    render(<WikiTab />)

    const title = await screen.findByText('架构设计文档')
    const row = title.closest('.wiki-page-list-item')
    expect(row).toHaveTextContent('资料')
    expect(row).toHaveTextContent('sources/architecture.md · 刚刚')
  })

  it('打开页面后仍可见列表，并出现关闭入口', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:page:list': [{
        id: 'p1',
        path: 'sources/a',
        category: 'sources',
        title: '架构',
        version: 1,
        updatedAt: Date.now(),
      }],
      'wiki:page:get': {
        id: 'p1',
        path: 'sources/a',
        category: 'sources',
        title: '架构',
        contentMd: '# hi',
        version: 1,
        updatedAt: Date.now(),
      },
      'wiki:link:backlinks': [],
      'wiki:page:revisions': [],
    })
    render(<WikiTab />)

    const listTitle = await screen.findByText('架构')
    fireEvent.click(listTitle)

    expect(await screen.findByRole('button', { name: '关闭' })).toBeInTheDocument()
    expect(listTitle.closest('.wiki-page-list-item')).toHaveClass('wiki-page-list-item--selected')
  })

  it('左栏一级含图谱与更多，不含运维工具独立入口', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无页面/)

    expect(screen.getByText('知识图谱')).toBeInTheDocument()
    expect(screen.getByText('⋯ 更多')).toBeInTheDocument()
    expect(screen.queryByText('运行日志')).not.toBeInTheDocument()
    expect(screen.queryByText('清理')).not.toBeInTheDocument()
    expect(screen.queryByText('综述合成')).not.toBeInTheDocument()
    expect(screen.queryByText('重建索引')).not.toBeInTheDocument()
  })

  it('图谱节点打开详情抽屉后保持图谱主区', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:page:list': [{
        id: 'p1',
        path: 'sources/graph-page',
        category: 'sources',
        title: '图谱页面',
        version: 1,
        updatedAt: Date.now(),
      }],
      'wiki:graph:data': {
        nodes: [{
          id: 'p1',
          kind: 'page',
          title: '图谱页面',
          path: 'sources/graph-page',
          category: 'sources',
          useCount: 0,
        }],
        edges: [],
        truncated: false,
      },
      'wiki:page:get': {
        id: 'p1',
        path: 'sources/graph-page',
        category: 'sources',
        title: '图谱页面',
        contentMd: '# 图谱页面',
        version: 1,
        updatedAt: Date.now(),
      },
      'wiki:link:backlinks': [],
      'wiki:page:revisions': [],
    })
    render(<WikiTab />)

    fireEvent.click(await screen.findByText('知识图谱'))
    fireEvent.change(screen.getByDisplayValue('或分类…'), { target: { value: 'sources' } })
    fireEvent.click(screen.getByRole('button', { name: '查看图谱' }))
    await waitFor(() => expect(document.querySelector('.react-flow__node')).toBeInTheDocument())
    fireEvent.click(document.querySelector('.react-flow__node')!)

    expect(await screen.findByRole('button', { name: '关闭' })).toBeInTheDocument()
    expect(document.querySelector('.wiki-graph-view')).toBeInTheDocument()
  })

  it('从更多菜单打开清理全页并显示清理控件', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无页面/)

    fireEvent.click(screen.getByRole('button', { name: '⋯ 更多' }))
    expect(screen.getByRole('menuitem', { name: /清理/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /综述合成/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /重建索引/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: /清理/ }))
    expect(screen.getByRole('heading', { name: '清理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /扫描/ })).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('点击更多菜单外部后关闭菜单', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无页面/)

    fireEvent.click(screen.getByRole('button', { name: '⋯ 更多' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('再次点击更多按钮时关闭菜单', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无页面/)

    const moreButton = screen.getByRole('button', { name: '⋯ 更多' })
    fireEvent.click(moreButton)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.mouseDown(moreButton)
    fireEvent.click(moreButton)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('从更多菜单切换一级导航时关闭菜单', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无页面/)

    fireEvent.click(screen.getByRole('button', { name: '⋯ 更多' }))
    fireEvent.click(screen.getByRole('button', { name: /^待整理/ }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('从更多菜单触发重建索引任务且不切换全页', async () => {
    const sendCommand = mockSendCommand({
      'wiki:index:rebuild': { rebuiltCount: 3 },
    })
    ;(window as any).electronAPI.agentRuntime.sendCommand = sendCommand
    render(<WikiTab />)
    await screen.findByText(/暂无页面/)

    fireEvent.click(screen.getByRole('button', { name: '⋯ 更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /重建索引/ }))

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith({ type: 'wiki:index:rebuild' })
    })
    expect(screen.getByText(/暂无页面/)).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('任务中心将任务按失败、进行中和最近完成分段展示', () => {
    const tasks: WikiLocalTask[] = [
      {
        id: 'running',
        kind: 'rebuild',
        title: '重建索引',
        phase: 'running',
        createdAt: 30,
      },
      {
        id: 'failed',
        kind: 'archive',
        title: '归档资料',
        phase: 'failed',
        error: '归档失败',
        createdAt: 20,
        finishedAt: 25,
        retryable: true,
      },
      {
        id: 'succeeded',
        kind: 'cleanup',
        title: '清理资料',
        phase: 'succeeded',
        createdAt: 10,
        finishedAt: 15,
      },
    ]

    render(
      <WikiTaskCenter
        open
        tasks={tasks}
        onClose={() => undefined}
        onRetry={() => undefined}
        onDismiss={() => undefined}
      />,
    )

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(headings).toEqual(['失败', '进行中', '最近完成'])
    expect(screen.getByText('归档失败')).toBeInTheDocument()
  })

  it('挂载时合并历史运行，点击失败 pill 打开任务中心', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:runs:list': [{
        id: 'run-failed',
        inboxIds: ['inbox-1'],
        status: 'failed',
        resultSummary: '归档资料',
        error: '解析失败',
        resultDetail: null,
        createdAt: 10,
        finishedAt: 20,
      }],
    })

    render(<WikiTab />)

    fireEvent.click(await screen.findByRole('button', { name: /任务失败/ }))
    expect(screen.getByRole('dialog', { name: '任务中心' })).toBeInTheDocument()
    expect(screen.getByText('解析失败')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /任务失败/ })).not.toBeInTheDocument()
  })

  it('待整理条目展示重试/丢弃操作，点击后重新加载', async () => {
    const retry = vi.fn()
    ;(window as any).electronAPI.agentRuntime.sendCommand = vi.fn(async (cmd: { type: string; inboxId?: string }) => {
      if (cmd.type === 'wiki:inbox:list') {
        return [
          { id: 'i1', itemType: 'upload', title: 'a.png', contentPreview: null, mediaType: 'image', status: 'pending', attemptCount: 1, lastError: '网络错误', createdAt: Date.now() },
        ]
      }
      if (cmd.type === 'wiki:inbox:count') {
        return { total: 1 }
      }
      if (cmd.type === 'wiki:inbox:retry') {
        retry(cmd.inboxId)
        return { success: true }
      }
      if (cmd.type === 'wiki:page:list' || cmd.type === 'wiki:runs:list') return []
      return null
    })
    render(<WikiTab />)

    fireEvent.click(screen.getByText('待整理'))
    await screen.findByText('a.png')
    expect(screen.getByText(/失败原因: 网络错误/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(retry).toHaveBeenCalledWith('i1'))
  })

  it('待整理失败项显示中文状态与重试', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:inbox:list': [{
        id: 'i1',
        itemType: 'file',
        title: '导出报告',
        contentPreview: 'x',
        mediaType: 'document',
        status: 'failed',
        attemptCount: 2,
        lastError: '超时',
        createdAt: Date.now(),
      }],
      'wiki:inbox:count': { total: 1 },
    })
    render(<WikiTab />)

    fireEvent.click(await screen.findByText('待整理'))
    expect(await screen.findByText('失败')).toBeInTheDocument()
    expect(screen.getByText('重试')).toBeInTheDocument()
    expect(screen.queryByText(/^failed$/)).not.toBeInTheDocument()
  })
})
