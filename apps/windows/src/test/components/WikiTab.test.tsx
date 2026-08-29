/**
 * WikiTab：用途目录树导航、文件列表、归档选择器与搜索交互
 * （mock window.electronAPI.agentRuntime.sendCommand）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WikiTab } from '../../renderer/pages/MemoriesPage/components/WikiTab'
import { WikiTaskCenter } from '../../renderer/pages/MemoriesPage/components/WikiTaskCenter'
import type { WikiLocalTask } from '../../renderer/pages/MemoriesPage/components/useWikiTaskCenter'

const TOPIC_TREE = {
  version: 1,
  categories: [
    { name: '做事记录', subtopics: ['项目/任务资料', '会议聊天记录'] },
    { name: '证件凭据', subtopics: ['合同协议文件', '证件扫描副本'] },
  ],
}

/** 展开左栏大类，便于在默认收起状态下访问小类 */
async function expandWikiCategory(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `展开 ${name}` }))
}

/** 读取左栏目录树节点右侧的文件数量角标 */
function getNavTopicCount(label: string): string | null {
  const labelEl = screen.getAllByText(label).find((node) => node.classList.contains('wiki-left-nav-label'))
  return labelEl?.parentElement?.querySelector('.wiki-left-nav-count')?.textContent ?? null
}

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
      case 'wiki:topic:tree:get':
        return { tree: TOPIC_TREE }
      case 'wiki:source:list':
        return { sources: [] }
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

  it('左栏渲染用途目录树与固定入口，不含资料/多媒体一级项', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    expect(screen.getByText('做事记录')).toBeInTheDocument()
    expect(screen.queryByText('项目/任务资料')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^待整理/ })).toBeInTheDocument()
    expect(screen.getByText('临时存放')).toBeInTheDocument()
    expect(screen.getByText('知识图谱')).toBeInTheDocument()
    expect(screen.getByText('更多')).toBeInTheDocument()
    expect(screen.queryByText('资料')).not.toBeInTheDocument()
    expect(screen.queryByText('多媒体')).not.toBeInTheDocument()
  })

  it('空小类可点击并显示专属空状态', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    await expandWikiCategory('做事记录')
    fireEvent.click(screen.getByText('会议聊天记录'))
    expect(await screen.findByText('这个小类下还没有文件')).toBeInTheDocument()
  })

  it('点击小类后主区列出该小类下的文件', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:source:list': {
        sources: [{
          id: 's1',
          title: '周会纪要.docx',
          sourcePath: 'C:/files/周会纪要.docx',
          mediaType: 'document',
          topicCategory: '做事记录',
          topicSubtopic: '会议聊天记录',
          updatedAt: Date.now(),
          useCount: 0,
        }],
      },
    })
    render(<WikiTab />)

    await screen.findByText(/暂无待整理条目/)
    await expandWikiCategory('做事记录')
    fireEvent.click(await screen.findByText('会议聊天记录'))
    const title = await screen.findByText('周会纪要.docx')
    expect(title.closest('.wiki-file-list-item')).toHaveTextContent('刚刚')
    expect(screen.getByRole('heading', { name: '做事记录 / 会议聊天记录（1）' })).toBeInTheDocument()
  })

  it('文件行「打开」失败时展示无法打开原文件', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = vi.fn(async (cmd: { type: string }) => {
      if (cmd.type === 'wiki:source:open') throw new Error('无法打开原文件：文件已被移动或删除')
      if (cmd.type === 'wiki:source:list') {
        return {
          sources: [{
            id: 's1',
            title: '合同.pdf',
            sourcePath: 'C:/files/合同.pdf',
            mediaType: 'document',
            topicCategory: '证件凭据',
            topicSubtopic: '合同协议文件',
            updatedAt: Date.now(),
            useCount: 0,
          }],
        }
      }
      if (cmd.type === 'wiki:topic:tree:get') return { tree: TOPIC_TREE }
      if (cmd.type === 'wiki:inbox:count') return { total: 0 }
      if (cmd.type === 'wiki:inbox:list' || cmd.type === 'wiki:page:list' || cmd.type === 'wiki:runs:list') return []
      return null
    })
    render(<WikiTab />)

    await screen.findByText(/暂无待整理条目/)
    await expandWikiCategory('证件凭据')
    fireEvent.click(await screen.findByText('合同协议文件'))
    fireEvent.click(await screen.findByRole('button', { name: /打开/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('无法打开原文件')
  })

  it('待整理条目可通过选择器归档到指定小类', async () => {
    const sendCommand = mockSendCommand({
      'wiki:inbox:list': [{
        id: 'i1',
        itemType: 'file',
        title: '劳动合同.pdf',
        contentPreview: null,
        mediaType: 'document',
        status: 'pending',
        attemptCount: 0,
        lastError: null,
        createdAt: Date.now(),
      }],
      'wiki:inbox:count': { total: 1 },
      'wiki:inbox:organize': { sourceId: 's1', category: '证件凭据', subtopic: '合同协议文件' },
    })
    ;(window as any).electronAPI.agentRuntime.sendCommand = sendCommand
    render(<WikiTab />)

    fireEvent.click(await screen.findByText('归档到…'))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '证件凭据' }))
    fireEvent.click(await dialog.findByRole('button', { name: '合同协议文件' }))
    fireEvent.click(dialog.getByRole('button', { name: '确认归档' }))

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        type: 'wiki:inbox:organize',
        inboxId: 'i1',
        category: '证件凭据',
        subtopic: '合同协议文件',
      }))
    })
  })

  it('临时存放列出搁置文件并提供移出，副文案与待整理可区分', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:source:list': {
        sources: [{
          id: 's9',
          title: '待定方案.pptx',
          sourcePath: 'C:/files/待定方案.pptx',
          mediaType: 'document',
          topicCategory: '临时存放',
          topicSubtopic: null,
          updatedAt: Date.now(),
          useCount: 0,
        }],
      },
    })
    render(<WikiTab />)

    fireEvent.click(await screen.findByText('临时存放'))
    expect(await screen.findByText('待定方案.pptx')).toBeInTheDocument()
    expect(screen.getByText('你主动搁置、暂不进入正式目录的文件')).toBeInTheDocument()
    expect(screen.queryByText('系统还在归档或无法自动归类的文件')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /移出/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /存到临时存放/ })).not.toBeInTheDocument()
  })

  it('搜索结果以文件形态展示并带大类小类', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:search': {
        hits: [{
          sourceId: 's1',
          title: '架构设计文档.md',
          category: '做事记录',
          subtopic: '项目/任务资料',
          snippet: '正文片段',
          mediaType: 'document',
          sourcePath: 'C:/files/架构设计文档.md',
          updatedAt: Date.now(),
        }],
        mode: 'fts',
        degradeReason: null,
      },
    })
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    const input = screen.getByPlaceholderText('搜索 Wiki…')
    fireEvent.change(input, { target: { value: '架构设计' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const title = await screen.findByText('架构设计文档.md')
    expect(title.closest('.wiki-file-list-item')).toHaveTextContent('做事记录 / 项目/任务资料')
    expect(screen.getByRole('heading', { name: /搜索结果（1）/ })).toBeInTheDocument()
  })

  it('更多菜单含历史页面与编辑主题树', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.getByRole('menuitem', { name: /历史页面/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /清理/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /重建索引/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /编辑主题树/ })).toBeInTheDocument()
  })

  it('更多菜单点编辑主题树打开编辑弹层', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /编辑主题树/ }))
    expect(await screen.findByText('编辑主题树')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /添加大类/ })).toBeInTheDocument()
  })

  it('历史页面视图打开旧摘要详情抽屉', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:page:list': [{
        id: 'p1',
        path: 'sources/architecture.md',
        category: 'sources',
        title: '架构设计文档',
        version: 1,
        updatedAt: Date.now(),
      }],
      'wiki:page:get': {
        id: 'p1',
        path: 'sources/architecture.md',
        category: 'sources',
        title: '架构设计文档',
        contentMd: '# 架构设计文档',
        version: 1,
        updatedAt: Date.now(),
      },
      'wiki:link:backlinks': [],
      'wiki:page:revisions': [],
    })
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /历史页面/ }))
    fireEvent.click(await screen.findByText('架构设计文档'))

    expect(await screen.findByRole('button', { name: '关闭' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '历史页面（1）' })).toBeInTheDocument()
  })

  it('从更多菜单打开清理全页并显示清理控件', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /清理/ }))

    expect(screen.getByRole('heading', { name: '清理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重新扫描/ })).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('图谱节点点击后自动加载图谱', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:source:list': [{ id: 's1', title: '资料A.pdf', sourcePath: null, topicCategory: '做事记录', topicSubtopic: '会议聊天记录', contentHash: 'h1', mediaType: 'application/pdf', sizeBytes: 1024 }],
      'wiki:inbox:list': [],
      'wiki:inbox:count': 0,
      'wiki:page:list': [],
      'wiki:graph:data': {
        nodes: [{
          id: 's1',
          kind: 'source',
          title: '资料A.pdf',
        }],
        edges: [],
        truncated: false,
      },
    })
    render(<WikiTab />)

    fireEvent.click(await screen.findByText('知识图谱'))
    await waitFor(() => expect(document.querySelector('.react-flow__node')).toBeInTheDocument())
    expect(document.querySelector('.wiki-graph-view')).toBeInTheDocument()
  })

  it('点击更多菜单外部后关闭菜单', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('再次点击更多按钮时关闭菜单', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    const moreButton = screen.getByRole('button', { name: '更多' })
    fireEvent.click(moreButton)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.mouseDown(moreButton)
    fireEvent.click(moreButton)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('从更多菜单切换目录导航时关闭菜单', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByText('做事记录'))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('大类默认收起，chevron 可展开/折叠且不切换主区', async () => {
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    expect(screen.queryByText('会议聊天记录')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开 做事记录' }))
    expect(screen.getByText('会议聊天记录')).toBeInTheDocument()
    expect(screen.getByText(/暂无待整理条目/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '折叠 做事记录' }))
    expect(screen.queryByText('会议聊天记录')).not.toBeInTheDocument()
  })

  it('左栏大类与小类始终显示文件数量角标', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:source:list': {
        sources: [{
          id: 's1',
          title: '周会纪要.docx',
          sourcePath: 'C:/files/周会纪要.docx',
          mediaType: 'document',
          topicCategory: '做事记录',
          topicSubtopic: '会议聊天记录',
          updatedAt: Date.now(),
          useCount: 0,
        }],
      },
    })
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    await waitFor(() => {
      expect(getNavTopicCount('做事记录')).toBe('1')
    })
    expect(getNavTopicCount('证件凭据')).toBe('0')

    await expandWikiCategory('做事记录')
    expect(getNavTopicCount('会议聊天记录')).toBe('1')
  })

  it('从更多菜单触发重建索引任务且不切换全页', async () => {
    const sendCommand = mockSendCommand({
      'wiki:index:rebuild': { rebuiltCount: 3 },
    })
    ;(window as any).electronAPI.agentRuntime.sendCommand = sendCommand
    render(<WikiTab />)
    await screen.findByText(/暂无待整理条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /重建索引/ }))

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith({ type: 'wiki:index:rebuild' })
    })
    expect(screen.getByText(/暂无待整理条目/)).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('任务中心将任务按失败、进行中和最近完成分段展示', () => {
    const tasks: WikiLocalTask[] = [
      { id: 'running', kind: 'rebuild', title: '重建索引', phase: 'running', createdAt: 30 },
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
      { id: 'succeeded', kind: 'cleanup', title: '清理资料', phase: 'succeeded', createdAt: 10, finishedAt: 15 },
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

  it('挂载时合并历史失败运行但不重新点亮失败 pill', async () => {
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

    await waitFor(() => {
      expect(
        (window as any).electronAPI.agentRuntime.sendCommand,
      ).toHaveBeenCalledWith({ type: 'wiki:runs:list' })
    })
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
      if (cmd.type === 'wiki:inbox:count') return { total: 1 }
      if (cmd.type === 'wiki:inbox:retry') {
        retry(cmd.inboxId)
        return { success: true }
      }
      if (cmd.type === 'wiki:topic:tree:get') return { tree: TOPIC_TREE }
      if (cmd.type === 'wiki:source:list') return { sources: [] }
      if (cmd.type === 'wiki:page:list' || cmd.type === 'wiki:runs:list') return []
      return null
    })
    render(<WikiTab />)

    await screen.findByText('a.png')
    expect(screen.getByText(/失败原因: 网络错误/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(retry).toHaveBeenCalledWith('i1'))
  })

  it('AI 拿不准的条目显示待人工归档，不报成失败', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:inbox:list': [{
        id: 'i1',
        itemType: 'upload',
        title: '会议纪要',
        contentPreview: null,
        mediaType: 'document',
        status: 'pending',
        attemptCount: 2,
        lastError: '无法归类',
        lastOutcome: 'degraded',
        createdAt: Date.now(),
      }],
    })
    render(<WikiTab />)

    await screen.findByText('会议纪要')
    expect(screen.getByText(/待人工归档: 无法归类/)).toBeInTheDocument()
    expect(screen.queryByText(/失败原因/)).not.toBeInTheDocument()
    expect(screen.queryByText(/已重试/)).not.toBeInTheDocument()
    // 仍可手动归档
    expect(screen.getByRole('button', { name: '归档到…' })).toBeInTheDocument()
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

    expect(await screen.findByText('失败')).toBeInTheDocument()
    expect(screen.getByText('重试')).toBeInTheDocument()
    expect(screen.queryByText(/^failed$/)).not.toBeInTheDocument()
  })

  it('待补分文件在待整理下单独成段并计入角标', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:inbox:count': { total: 1 },
      'wiki:inbox:list': [{
        id: 'i1',
        itemType: 'file',
        title: '队列文件.pdf',
        contentPreview: null,
        mediaType: 'document',
        status: 'pending',
        attemptCount: 0,
        lastError: null,
        createdAt: Date.now(),
      }],
      'wiki:source:list': {
        sources: [{
          id: 's1',
          title: '未分类文件.pdf',
          sourcePath: 'C:/files/未分类文件.pdf',
          mediaType: 'document',
          topicCategory: null,
          topicSubtopic: null,
          updatedAt: Date.now(),
          useCount: 0,
        }],
      },
    })
    render(<WikiTab />)

    expect(await screen.findByRole('heading', { name: '待补分（1）' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '待整理（2）' })).toBeInTheDocument()
    expect(screen.getByText('未分类文件.pdf')).toBeInTheDocument()
  })
})
