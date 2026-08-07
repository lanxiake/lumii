/**
 * ChatSidebar 组件测试
 * 测试 Phase 4: 会话管理增强 - 搜索/分组/置顶
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChatSidebar from '../../renderer/pages/ChatPage/components/ChatSidebar'
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
    onPinSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onRenameSession: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('TC-4.1 SessionSearch 搜索功能', () => {
    it('TC-4.1.1: 搜索框正常渲染', () => {
      render(<ChatSidebar {...mockProps} />)

      const searchInput = screen.getByPlaceholderText('搜索会话...')
      expect(searchInput).toBeInTheDocument()
    })

    it('TC-4.1.2: 输入关键词搜索标题', () => {
      const sessions = [
        createMockSession({ id: 's1', title: 'React开发' }),
        createMockSession({ id: 's2', title: 'Vue项目' }),
      ]
      render(<ChatSidebar {...mockProps} sessions={sessions} />)

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
      render(<ChatSidebar {...mockProps} sessions={sessions} />)

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
      render(<ChatSidebar {...mockProps} sessions={sessions} />)

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
      render(<ChatSidebar {...mockProps} sessions={sessions} />)

      const searchInput = screen.getByPlaceholderText('搜索会话...')
      fireEvent.change(searchInput, { target: { value: '不存在的内容' } })

      expect(screen.getByText('未找到匹配的会话')).toBeInTheDocument()
    })

    it('TC-4.1.6: 点击清除按钮清空搜索', () => {
      render(<ChatSidebar {...mockProps} />)

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
      render(<ChatSidebar {...mockProps} sessions={sessions} />)

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
      render(<ChatSidebar {...mockProps} sessions={sessions} />)
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
      render(<ChatSidebar {...mockProps} sessions={sessions} />)
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
      render(<ChatSidebar {...mockProps} sessions={sessions} />)
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
      render(<ChatSidebar {...mockProps} sessions={sessions} />)
      fireEvent.click(screen.getByRole('tab', { name: '渠道' }))

      expect(screen.getByText('(2)')).toBeInTheDocument()
    })
  })

  describe('TC-4.3 新建会话功能', () => {
    it('TC-4.3.1: 点击新建按钮触发回调', () => {
      render(<ChatSidebar {...mockProps} />)

      // 「+」是独立 span，文本被拆开，按可访问名匹配整个按钮
      const newBtn = screen.getByRole('button', { name: /新建对话/ })
      fireEvent.click(newBtn)

      expect(mockProps.onCreateSession).toHaveBeenCalled()
    })
  })

  describe('TC-4.4 空状态显示', () => {
    it('TC-4.4.1: 无会话时显示提示', () => {
      render(<ChatSidebar {...mockProps} sessions={[]} />)

      // 默认 tab 下「系统默认」分组始终渲染（total=0 也不隐藏），
      // 因此走的是分组内空态「暂无会话」，而非顶层「暂无会话，点击上方按钮创建」
      expect(screen.getByText('暂无会话')).toBeInTheDocument()
    })
  })
})
