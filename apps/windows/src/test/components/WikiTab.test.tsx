/**
 * WikiTab：空状态渲染、分类切换、搜索交互（mock window.electronAPI.agentRuntime.sendCommand）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WikiTab } from '../../renderer/pages/MemoriesPage/components/WikiTab'

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
