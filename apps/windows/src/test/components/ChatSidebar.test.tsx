/**
 * ChatSidebar 组件测试
 * 测试 Phase 4: 会话管理增强 - 搜索/分组/置顶
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ComponentProps } from 'react'
import ChatSidebar from '../../renderer/pages/ChatPage/components/ChatSidebar'
import { SettingsHubProvider } from '../../renderer/components/SettingsHub/SettingsHubContext'
import type { ChatSession } from '../../renderer/hooks/business/useChat'

describe('Phase 4: 会话管理 - ChatSidebar组件', () => {
  const createMockSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
    id: 'session-1',
    title: '测试会话',
    isPinned: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: 'Hello world',
        timestamp: new Date(),
      },
    ],
    source: 'local' as const,
    ...overrides,
  })

  const mockProps = {
    sessions: [],
    activeSessionId: null,
    onSelectSession: vi.fn(),
    onCreateSession: vi.fn(),
    onCreateSessionInGroup: vi.fn(),
    onClearGroupHistory: vi.fn(),
    onPinSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onRenameSession: vi.fn(),
  }

  const renderSidebar = (overrides: Partial<ComponentProps<typeof ChatSidebar>> = {}) =>
    render(
      <SettingsHubProvider>
        <ChatSidebar {...mockProps} {...overrides} />
      </SettingsHubProvider>,
    )

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('TC-4.1 SessionSearch 搜索功能', () => {
    it('TC-4.1.1: 搜索框正常渲染', () => {
      renderSidebar()

      const searchInput = screen.getByPlaceholderText('搜索会话...')
      expect(searchInput).toBeInTheDocument()
    })

    it('TC-4.1.2: 输入关键词搜索标题', () => {
      const sessions = [
        createMockSession({ id: 's1', title: 'React开发' }),
        createMockSession({ id: 's2', title: 'Vue项目' }),
      ]
      renderSidebar({ sessions })

      const searchInput = screen.getByPlaceholderText('搜索会话...')
      fireEvent.change(searchInput, { target: { value: 'React' } })

      // 应该只显示包含"React"的会话
      expect(screen.getByText('React开发')).toBeInTheDocument()
      expect(screen.queryByText('Vue项目')).not.toBeInTheDocument()
    })

    it('TC-4.1.3: 输入关键词搜索消息内容', () => {
      const sessions = [
        createMockSession({
          id: 's1',
          title: '会话1',
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'TypeScript问题',
              timestamp: new Date(),
            },
          ],
        }),
        createMockSession({
          id: 's2',
          title: '会话2',
          messages: [
            {
              id: 'm2',
              role: 'user',
              content: 'JavaScript代码',
              timestamp: new Date(),
            },
          ],
        }),
      ]
      renderSidebar({ sessions })

      const searchInput = screen.getByPlaceholderText('搜索会话...')
      fireEvent.change(searchInput, { target: { value: 'TypeScript' } })

      expect(screen.getByText('会话1')).toBeInTheDocument()
      expect(screen.queryByText('会话2')).not.toBeInTheDocument()
    })

    it('TC-4.1.4: 清空搜索框显示所有会话', () => {
      const sessions = [
        createMockSession({ id: 's1', title: 'React' }),
        createMockSession({ id: 's2', title: 'Vue' }),
      ]
      renderSidebar({ sessions })

      const searchInput = screen.getByPlaceholderText('搜索会话...')

      // 先搜索
      fireEvent.change(searchInput, { target: { value: 'React' } })
      expect(screen.queryByText('Vue')).not.toBeInTheDocument()

      // 清空搜索
      fireEvent.change(searchInput, { target: { value: '' } })
      expect(screen.getByText('React')).toBeInTheDocument()
      expect(screen.getByText('Vue')).toBeInTheDocument()
    })

    it('TC-4.1.5: 搜索无结果显示提示', () => {
      const sessions = [createMockSession({ id: 's1', title: 'React' })]
      renderSidebar({ sessions })

      const searchInput = screen.getByPlaceholderText('搜索会话...')
      fireEvent.change(searchInput, { target: { value: '不存在的内容' } })

      expect(screen.getByText('未找到匹配的会话')).toBeInTheDocument()
    })

    it('TC-4.1.6: 点击清除按钮清空搜索', () => {
      renderSidebar()

      const searchInput = screen.getByPlaceholderText('搜索会话...') as HTMLInputElement
      fireEvent.change(searchInput, { target: { value: 'test' } })

      const clearBtn = screen.getByTitle('清除搜索')
      fireEvent.click(clearBtn)

      expect(searchInput.value).toBe('')
    })
  })

  describe('TC-4.2 会话分组逻辑', () => {
    it('TC-4.2.1: 置顶会话显示在最上方', () => {
      const today = new Date()
      const sessions = [
        createMockSession({
          id: 's1',
          title: '普通会话',
          isPinned: false,
          updatedAt: today,
        }),
        createMockSession({
          id: 's2',
          title: '置顶会话',
          isPinned: true,
          updatedAt: today,
        }),
      ]
      renderSidebar({ sessions })

      // 置顶分组应该存在
      expect(screen.getByText('置顶')).toBeInTheDocument()
      expect(screen.getByText('置顶会话')).toBeInTheDocument()
    })

    // 时间分组（今天/昨天/更早）只在搜索模式下切分，平时列表按更新时间平铺，
    // 所以这三条都要先输入搜索词才能看到分组标签。
    it('TC-4.2.2: 今天创建的会话显示在"今天"分组', () => {
      const today = new Date()
      const sessions = [
        createMockSession({
          id: 's1',
          title: '今天的会话',
          updatedAt: today,
        }),
      ]
      renderSidebar({ sessions })
      fireEvent.change(screen.getByPlaceholderText('搜索会话...'), { target: { value: '会话' } })

      expect(screen.getByText('今天')).toBeInTheDocument()
    })

    it('TC-4.2.3: 昨天创建的会话显示在"昨天"分组', () => {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      const sessions = [
        createMockSession({
          id: 's1',
          title: '昨天的会话',
          updatedAt: yesterday,
        }),
      ]
      renderSidebar({ sessions })
      fireEvent.change(screen.getByPlaceholderText('搜索会话...'), { target: { value: '会话' } })

      expect(screen.getByText('昨天')).toBeInTheDocument()
    })

    it('TC-4.2.4: 更早创建的会话显示在"更早"分组', () => {
      const earlier = new Date()
      earlier.setDate(earlier.getDate() - 3)
      const sessions = [
        createMockSession({
          id: 's1',
          title: '更早的会话',
          updatedAt: earlier,
        }),
      ]
      renderSidebar({ sessions })
      fireEvent.change(screen.getByPlaceholderText('搜索会话...'), { target: { value: '会话' } })

      expect(screen.getByText('更早')).toBeInTheDocument()
    })

    it('TC-4.2.5: 分组数量显示正确', () => {
      const today = new Date()
      // 渠道计数只在「渠道」tab 的分组标题上展示（默认 tab 只有一个分组，
      // tab 本身已表明来源，不重复标题与计数），所以用外部渠道会话来验。
      const sessions = [
        createMockSession({ id: 's1', channel: 'wechat', updatedAt: today }),
        createMockSession({ id: 's2', channel: 'wechat', updatedAt: today }),
      ]
      renderSidebar({ sessions })
      fireEvent.click(screen.getByRole('tab', { name: '渠道' }))

      expect(screen.getByText('(2)')).toBeInTheDocument()
    })
  })

  describe('TC-4.3 新建会话功能', () => {
    it('TC-4.3.1: 点击新建按钮触发回调', () => {
      renderSidebar()

      // 底部全局入口；分组新建已收入「⋯」菜单
      const newBtn = screen.getByRole('button', { name: '新建对话' })
      fireEvent.click(newBtn)

      expect(mockProps.onCreateSession).toHaveBeenCalled()
    })
  })

  describe('TC-4.4 空状态显示', () => {
    it('TC-4.4.1: 无会话时默认组展示功能说明', () => {
      renderSidebar({ sessions: [] })

      // 默认 tab 下「默认」分组始终渲染（total=0 也不隐藏），展示中文职责说明
      expect(screen.getByText('通用助手，处理日常问答与多步任务')).toBeInTheDocument()
    })
  })

  describe('TC-4.5 默认 tab 多 Agent 分组', () => {
    const codeDevAgent = {
      id: 'code-dev',
      name: '灵栖开发',
      description: '负责代码开发与项目维护',
      selectable: true,
    }

    beforeEach(() => {
      ;(window as any).electronAPI = {
        ...(window as any).electronAPI,
        api: {
          getAgents: vi.fn().mockResolvedValue({
            success: true,
            data: { agents: [codeDevAgent] },
          }),
        },
      }
    })

    it('TC-4.5.1: 无会话时系统组用两字短名与中文空态说明', async () => {
      renderSidebar()

      expect(await screen.findByText('开发')).toBeInTheDocument()
      expect(screen.getByText('绑定项目，完成可验证的代码改动')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '「默认」更多操作' })).toBeInTheDocument()
      expect(screen.getByText('通用助手，处理日常问答与多步任务')).toBeInTheDocument()
    })

    it('TC-4.5.2: 成员组「⋯」菜单可在该组新建会话', async () => {
      renderSidebar()

      fireEvent.click(await screen.findByRole('button', { name: '「开发」更多操作' }))
      fireEvent.click(screen.getByText('在此新建对话'))

      expect(mockProps.onCreateSessionInGroup).toHaveBeenCalledWith('code-dev')
    })

    it('TC-4.5.3: 系统默认组「⋯」新建以 null 回调', async () => {
      renderSidebar()

      fireEvent.click(await screen.findByRole('button', { name: '「默认」更多操作' }))
      fireEvent.click(screen.getByText('在此新建对话'))

      expect(mockProps.onCreateSessionInGroup).toHaveBeenCalledWith(null)
    })

    it('TC-4.5.4: 组头不再显示「+」或折叠箭头', async () => {
      renderSidebar()

      expect(await screen.findByRole('button', { name: '「默认」更多操作' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /下新建对话/ })).not.toBeInTheDocument()
      expect(screen.queryByText('▾')).not.toBeInTheDocument()
    })

    it('TC-4.5.5: 打开分组菜单时关闭会话菜单，避免重叠', async () => {
      const sessions = [createMockSession({ id: 's1', title: '会话A' })]
      renderSidebar({ sessions })

      fireEvent.click(screen.getByRole('button', { name: '会话操作' }))
      expect(screen.getByText('重命名')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: '「默认」更多操作' }))
      expect(screen.queryByText('重命名')).not.toBeInTheDocument()
      expect(screen.getByText('在此新建对话')).toBeInTheDocument()
    })
  })

  describe('TC-4.6 分组「⋯」清空历史', () => {
    it('TC-4.6.1: 默认组菜单含新建与清空，「清空全部历史」回调携带分组会话', () => {
      const sessions = [
        createMockSession({ id: 's1', title: '会话A' }),
        createMockSession({ id: 's2', title: '会话B' }),
      ]
      renderSidebar({ sessions })

      fireEvent.click(screen.getByRole('button', { name: '「默认」更多操作' }))
      expect(screen.getByText('在此新建对话')).toBeInTheDocument()
      expect(screen.getByText('清空历史（保留最近 5 条）')).toBeInTheDocument()
      expect(screen.getByText('清空全部历史')).toBeInTheDocument()

      fireEvent.click(screen.getByText('清空全部历史'))
      expect(mockProps.onClearGroupHistory).toHaveBeenCalledWith({
        label: '默认',
        sessions,
        keepRecent: null,
      })
    })

    it('TC-4.6.2: 「保留最近 5 条」回调 keepRecent=5', () => {
      renderSidebar({ sessions: [createMockSession({ id: 's1' })] })

      fireEvent.click(screen.getByRole('button', { name: '「默认」更多操作' }))
      fireEvent.click(screen.getByText('清空历史（保留最近 5 条）'))

      expect(mockProps.onClearGroupHistory).toHaveBeenCalledWith(
        expect.objectContaining({ label: '默认', keepRecent: 5 }),
      )
    })

    it('TC-4.6.3: 自主进化组不提供清空菜单（会话不可删除）', () => {
      renderSidebar()

      fireEvent.click(screen.getByRole('tab', { name: '系统' }))
      expect(screen.queryByRole('button', { name: '「自主进化」更多操作' })).not.toBeInTheDocument()
    })
  })

  describe('TC-4.7 定时任务记录归入 Agent 分组', () => {
    const cronSession = (agentId: string, title: string) =>
      createMockSession({
        id: `cron:${title}`,
        title,
        agentId,
        channel: 'cron',
      })

    it('归属 chronicler 的定时任务记录出现在「记事」分组下', () => {
      renderSidebar({ sessions: [cronSession('chronicler', '定时任务 · 早间简报')] })

      expect(screen.getByText('记事')).toBeInTheDocument()
      expect(screen.getByText('定时任务 · 早间简报')).toBeInTheDocument()
    })

    it('系统默认 Agent 跑的后台任务不进「默认」分组（避免灌满后台记录）', () => {
      renderSidebar({ sessions: [cronSession('assistant', '定时任务 · 后台独白')] })

      expect(screen.queryByText('定时任务 · 后台独白')).not.toBeInTheDocument()
    })

    it('同一批记录仍保留在系统 tab 的「定时任务」分组下（两处指向同一会话）', () => {
      renderSidebar({ sessions: [cronSession('chronicler', '定时任务 · 早间简报')] })

      fireEvent.click(screen.getByRole('tab', { name: '系统' }))
      expect(screen.getByText('定时任务')).toBeInTheDocument()
      expect(screen.getByText('定时任务 · 早间简报')).toBeInTheDocument()
    })

    it('「清除历史」不下发定时任务记录，只清该 Agent 的普通对话', () => {
      const normal = createMockSession({ id: 's-normal', title: '和记事聊工作', agentId: 'chronicler' })
      renderSidebar({
        sessions: [normal, cronSession('chronicler', '定时任务 · 早间简报')],
      })

      fireEvent.click(screen.getByRole('button', { name: '「记事」更多操作' }))
      fireEvent.click(screen.getByText('清空全部历史'))

      expect(mockProps.onClearGroupHistory).toHaveBeenCalledWith(
        expect.objectContaining({ label: '记事', sessions: [normal] }),
      )
    })

    it('参与者是内部标记 main 的会话归入「默认」分组，不另开一个 main 分组', () => {
      renderSidebar({
        sessions: [
          createMockSession({ id: 's-main', title: '历史会话', agentId: 'main' }),
          createMockSession({ id: 's-default', title: '普通会话' }),
        ],
      })

      expect(screen.queryByRole('button', { name: '「main」更多操作' })).not.toBeInTheDocument()
      expect(screen.getByText('历史会话')).toBeInTheDocument()
      expect(screen.getByText('普通会话')).toBeInTheDocument()
    })

    it('参与者是 main 的定时任务记录不进分组（执行者未知，只留在系统 tab）', () => {
      renderSidebar({ sessions: [cronSession('main', '定时任务 · 已删除的任务')] })

      expect(screen.queryByText('定时任务 · 已删除的任务')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '「main」更多操作' })).not.toBeInTheDocument()
    })
  })
})
