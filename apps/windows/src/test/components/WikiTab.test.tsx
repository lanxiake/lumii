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
import { ToastProvider } from '../../renderer/components/ui/Toast/ToastContainer'

const TOPIC_TREE = {
  version: 2,
  categories: [
    { name: '工作', subtopics: ['项目', '例行', '对外'] },
    { name: '生活', subtopics: ['凭据', '家事', '自留'] },
  ],
}

/** 进入左栏分区（工作/学习/生活/收藏） */
async function selectNavSection(label: string) {
  const btn = await screen.findByRole('button', { name: new RegExp(`^${label}`) })
  fireEvent.click(btn)
}

/** 点击大类下的小类筛选 tab（与文件类型「全部」芯片区分） */
function clickSubtopicFilter(label: string) {
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(label) }))
}

/** 读取左栏分区按钮右侧的文件数量角标 */
function getNavSectionCount(label: string): string | null {
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

/** 包一层 Toast，WikiTab 依赖 useToast */
function renderWikiTab() {
  return render(
    <ToastProvider>
      <WikiTab />
    </ToastProvider>,
  )
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
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    expect(screen.getByText('工作')).toBeInTheDocument()
    expect(screen.getByText('生活')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^收件箱/ })).toBeInTheDocument()
    expect(screen.getByText('临时存放')).toBeInTheDocument()
    expect(screen.queryByText('知识图谱')).not.toBeInTheDocument()
    expect(screen.getByText('更多')).toBeInTheDocument()
    expect(screen.queryByText('资料')).not.toBeInTheDocument()
    expect(screen.queryByText('多媒体')).not.toBeInTheDocument()
  })

  it('空小类可点击并显示专属空状态', async () => {
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    await selectNavSection('工作')
    clickSubtopicFilter('例行')
    expect(await screen.findByText('这个小类下还没有文件')).toBeInTheDocument()
  })

  it('点击大类默认展示全部文件，并在文件名前显示小类', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:source:list': {
        sources: [{
          id: 's1',
          title: '周会纪要.docx',
          sourcePath: 'C:/files/周会纪要.docx',
          mediaType: 'document',
          topicCategory: '工作',
          topicSubtopic: '例行',
          updatedAt: Date.now(),
          useCount: 0,
        }],
      },
    })
    renderWikiTab()

    await screen.findByText(/暂无收件箱条目/)
    await selectNavSection('工作')
    const title = await screen.findByText('周会纪要.docx')
    expect(title.closest('.wiki-file-list-item')).toHaveTextContent('例行')
    expect(screen.getByRole('heading', { name: '工作 (1)' })).toBeInTheDocument()
  })

  it('点击小类后主区列出该小类下的文件', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:source:list': {
        sources: [{
          id: 's1',
          title: '周会纪要.docx',
          sourcePath: 'C:/files/周会纪要.docx',
          mediaType: 'document',
          topicCategory: '工作',
          topicSubtopic: '例行',
          updatedAt: Date.now(),
          useCount: 0,
        }],
      },
    })
    renderWikiTab()

    await screen.findByText(/暂无收件箱条目/)
    await selectNavSection('工作')
    clickSubtopicFilter('例行')
    const title = await screen.findByText('周会纪要.docx')
    expect(title.closest('.wiki-file-list-item')).toHaveTextContent('刚刚')
    expect(screen.getByRole('heading', { name: '例行 (1)' })).toBeInTheDocument()
    expect(document.querySelectorAll('.wiki-file-list-subtopic-prefix')).toHaveLength(0)
  })

  it('文件行「详情」使用应用内居中预览，不调系统打开', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = vi.fn(async (cmd: { type: string }) => {
      if (cmd.type === 'wiki:source:open') throw new Error('不应调用系统打开')
      if (cmd.type === 'wiki:source:list') {
        return {
          sources: [{
            id: 's1',
            title: '合同.pdf',
            sourcePath: 'C:/files/合同.pdf',
            mediaType: 'document',
            topicCategory: '生活',
            topicSubtopic: '凭据',
            updatedAt: Date.now(),
            useCount: 0,
          }],
        }
      }
      if (cmd.type === 'wiki:topic:tree:get') return { tree: TOPIC_TREE }
      if (cmd.type === 'wiki:inbox:count') return { total: 0 }
      if (cmd.type === 'wiki:inbox:list' || cmd.type === 'wiki:page:list' || cmd.type === 'wiki:runs:list') return []
      if (cmd.type === 'files:read-preview-by-path') {
        return { content: 'JVBERi0xLjQ=', mimeType: 'application/pdf', encoding: 'base64', fileName: '合同.pdf' }
      }
      return null
    })
    renderWikiTab()

    await screen.findByText(/暂无收件箱条目/)
    await selectNavSection('生活')
    clickSubtopicFilter('凭据')
    fireEvent.click(await screen.findByRole('button', { name: /详情/ }))

    expect(await screen.findByRole('dialog', { name: '文件预览' })).toBeInTheDocument()
    const send = (window as any).electronAPI.agentRuntime.sendCommand as ReturnType<typeof vi.fn>
    expect(send.mock.calls.some((c: [{ type: string }]) => c[0].type === 'wiki:source:open')).toBe(false)
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
      'wiki:inbox:organize': { sourceId: 's1', category: '生活', subtopic: '凭据' },
    })
    ;(window as any).electronAPI.agentRuntime.sendCommand = sendCommand
    renderWikiTab()

    fireEvent.click(await screen.findByText('归档到…'))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '生活' }))
    fireEvent.click(await dialog.findByRole('button', { name: '凭据' }))
    fireEvent.click(dialog.getByRole('button', { name: '确认归档' }))

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        type: 'wiki:inbox:organize',
        inboxId: 'i1',
        category: '生活',
        subtopic: '凭据',
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
    renderWikiTab()

    fireEvent.click(await screen.findByText('临时存放'))
    expect(await screen.findByText('待定方案.pptx')).toBeInTheDocument()
    expect(screen.getByText('你主动搁置、暂不进入正式目录的文件')).toBeInTheDocument()
    expect(screen.queryByText('系统还在归档或无法自动归类的文件')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /移出/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /存到临时存放/ })).not.toBeInTheDocument()
  })

  it('临时存放移出时「让 AI 建议」等到编目结束后展示结果', async () => {
    let getCount = 0
    ;(window as any).electronAPI.agentRuntime.sendCommand = vi.fn(async (cmd: { type: string }) => {
      if (cmd.type === 'wiki:source:list') {
        return {
          sources: [{
            id: 's9',
            title: '五年级语文课本.pdf',
            sourcePath: 'C:/files/五年级语文课本.pdf',
            mediaType: 'document',
            topicCategory: '临时存放',
            topicSubtopic: null,
            updatedAt: Date.now(),
            useCount: 0,
          }],
        }
      }
      if (cmd.type === 'wiki:topic:tree:get') return { tree: TOPIC_TREE }
      if (cmd.type === 'wiki:inbox:count') return { total: 0 }
      if (cmd.type === 'wiki:inbox:list' || cmd.type === 'wiki:page:list' || cmd.type === 'wiki:runs:list') return []
      if (cmd.type === 'wiki:reclassify:run') return { runId: 'r1' }
      if (cmd.type === 'wiki:reclassify:get') {
        getCount += 1
        if (getCount === 1) return { run: { status: 'running', candidates: [] } }
        return {
          run: {
            status: 'review',
            candidates: [{ toCategory: '学习', toSubtopic: '在学', reason: '小学语文教材' }],
          },
        }
      }
      if (cmd.type === 'wiki:reclassify:discard') return { success: true }
      return null
    })
    renderWikiTab()
    fireEvent.click(await screen.findByText('临时存放'))
    fireEvent.click(await screen.findByRole('button', { name: /移出/ }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '让 AI 建议' }))
    expect(await dialog.findByText(/AI 建议：学习 \/ 在学/)).toBeInTheDocument()
  })

  it('搜索结果以文件形态展示并带大类小类', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:search': {
        hits: [{
          sourceId: 's1',
          title: '架构设计文档.md',
          category: '工作',
          subtopic: '项目',
          snippet: '正文片段',
          mediaType: 'document',
          sourcePath: 'C:/files/架构设计文档.md',
          updatedAt: Date.now(),
        }],
        mode: 'fts',
        degradeReason: null,
      },
    })
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    const input = screen.getByPlaceholderText('搜索 Wiki…')
    fireEvent.change(input, { target: { value: '架构设计' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const title = await screen.findByText('架构设计文档.md')
    expect(title.closest('.wiki-file-list-item')).toHaveTextContent('工作 / 项目')
    expect(screen.getByRole('heading', { name: /搜索结果（1）/ })).toBeInTheDocument()
  })

  it('更多菜单含清理与编辑主题树', async () => {
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.getByRole('menuitem', { name: /清理/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /重建索引/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /编辑主题树/ })).toBeInTheDocument()
  })

  it('更多菜单点编辑主题树打开编辑弹层', async () => {
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /编辑主题树/ }))
    expect(await screen.findByText('编辑主题树')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /添加大类/ })).toBeInTheDocument()
  })

  it('从更多菜单打开清理全页并显示清理控件', async () => {
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /清理/ }))

    expect(screen.getByRole('heading', { name: '清理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重新扫描/ })).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('不显示知识图谱入口', async () => {
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    expect(screen.queryByText('知识图谱')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /知识图谱/ })).not.toBeInTheDocument()
  })

  it('点击更多菜单外部后关闭菜单', async () => {
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('再次点击更多按钮时关闭菜单', async () => {
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    const moreButton = screen.getByRole('button', { name: '更多' })
    fireEvent.click(moreButton)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.mouseDown(moreButton)
    fireEvent.click(moreButton)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('从更多菜单切换视图时关闭菜单', async () => {
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /清理/ }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('左栏分区显示文件数量角标', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:source:list': {
        sources: [{
          id: 's1',
          title: '周会纪要.docx',
          sourcePath: 'C:/files/周会纪要.docx',
          mediaType: 'document',
          topicCategory: '工作',
          topicSubtopic: '例行',
          updatedAt: Date.now(),
          useCount: 0,
        }],
      },
    })
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    await waitFor(() => {
      expect(getNavSectionCount('工作')).toBe('1')
    })

    await selectNavSection('工作')
    expect(screen.getByRole('tab', { name: /全部/ })).toHaveClass('wiki-subtopic-chip--active')
    expect(screen.getByRole('tab', { name: /例行/ }).querySelector('.wiki-subtopic-chip-count')).toHaveTextContent('1')
  })

  it('大类角标含树外旧小类的文件，分区页列出该旧小类', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:source:list': {
        sources: [
          {
            id: 's1',
            title: '五年级语文.pdf',
            sourcePath: 'C:/files/a.pdf',
            mediaType: 'document',
            topicCategory: '工作',
            topicSubtopic: '课堂&课程笔记',
            updatedAt: Date.now(),
            useCount: 0,
          },
          {
            id: 's2',
            title: '模板.docx',
            sourcePath: 'C:/files/b.docx',
            mediaType: 'document',
            topicCategory: '工作',
            topicSubtopic: '各类文档模板',
            updatedAt: Date.now(),
            useCount: 0,
          },
        ],
      },
    })
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)
    await waitFor(() => {
      expect(getNavSectionCount('工作')).toBe('2')
    })

    await selectNavSection('工作')
    expect(await screen.findByText(/按小类筛选/)).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /全部/ })).toHaveClass('wiki-subtopic-chip--active')
    expect(screen.getByRole('tab', { name: /课堂&课程笔记/ }).querySelector('.wiki-subtopic-chip-count')).toHaveTextContent('1')
    expect(screen.getByRole('tab', { name: /各类文档模板/ }).querySelector('.wiki-subtopic-chip-count')).toHaveTextContent('1')
    expect(screen.getByRole('tab', { name: /^例行$/ }).querySelector('.wiki-subtopic-chip-count')).toBeNull()

    clickSubtopicFilter('课堂&课程笔记')
    expect(await screen.findByText('五年级语文.pdf')).toBeInTheDocument()
  })

  it('从更多菜单触发重建索引任务且不切换全页', async () => {
    const sendCommand = mockSendCommand({
      'wiki:index:rebuild': { rebuiltCount: 3 },
    })
    ;(window as any).electronAPI.agentRuntime.sendCommand = sendCommand
    renderWikiTab()
    await screen.findByText(/暂无收件箱条目/)

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /重建索引/ }))

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith({ type: 'wiki:index:rebuild' })
    })
    expect(screen.getByText(/暂无收件箱条目/)).toBeInTheDocument()
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

    renderWikiTab()

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
    renderWikiTab()

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
    renderWikiTab()

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
    renderWikiTab()

    expect(await screen.findByText('失败')).toBeInTheDocument()
    expect(screen.getByText('重试')).toBeInTheDocument()
    expect(screen.queryByText(/^failed$/)).not.toBeInTheDocument()
  })

  it('未分类文件与队列条目合并在收件箱列表并计入角标', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:inbox:count': { total: 1, pending: 1 },
      'wiki:inbox:list': [{
        id: 'i1',
        itemType: 'file',
        title: '队列文件.pdf',
        contentPreview: null,
        mediaType: 'document',
        status: 'pending',
        attemptCount: 0,
        lastError: null,
        createdAt: Date.now() - 1000,
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
    renderWikiTab()

    expect(await screen.findByText('未分类文件.pdf')).toBeInTheDocument()
    expect(screen.getByText('队列文件.pdf')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '收件箱（2）' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /全部交给 AI 分类/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /待补分/ })).not.toBeInTheDocument()
    expect(screen.queryByText('待整理')).not.toBeInTheDocument()
  })

  it('已归入收藏的文件即使仍有未分类重复行也不出现在收件箱', async () => {
    ;(window as any).electronAPI.agentRuntime.sendCommand = mockSendCommand({
      'wiki:topic:tree:get': {
        tree: {
          version: 2,
          categories: [
            { name: '工作', subtopics: ['项目', '例行', '对外'] },
            { name: '收藏', subtopics: ['待读', '可复用', '范例'] },
          ],
        },
      },
      'wiki:inbox:count': { total: 0, pending: 0, unfiled: 0 },
      'wiki:inbox:list': [],
      'wiki:source:list': {
        sources: [
          {
            id: 's-filed',
            title: '拍照姿势21.mp4',
            sourcePath: 'wiki/收藏/可复用/拍照姿势21.lumii-ref',
            mediaType: 'video',
            topicCategory: '收藏',
            topicSubtopic: '可复用',
            updatedAt: Date.now(),
            useCount: 0,
          },
          {
            id: 's-unfiled',
            title: '拍照姿势21.mp4',
            sourcePath: 'C:/教材/拍照姿势21.mp4',
            mediaType: 'video',
            topicCategory: null,
            topicSubtopic: null,
            updatedAt: Date.now(),
            useCount: 0,
          },
        ],
      },
    })
    renderWikiTab()

    expect(await screen.findByText(/暂无收件箱条目/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '收件箱（0）' })).toBeInTheDocument()

    await selectNavSection('收藏')
    clickSubtopicFilter('可复用')
    expect(await screen.findByText('拍照姿势21.mp4')).toBeInTheDocument()
  })
})
