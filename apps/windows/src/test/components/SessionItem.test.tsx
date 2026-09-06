/**
 * SessionItem 组件测试
 * 单行布局：状态图标 / ··· 菜单 / 右键菜单 / 重命名
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import SessionItem from '../../renderer/pages/ChatPage/components/SessionItem'
import type { ChatSession } from '../../renderer/hooks/business/useChat'

describe('Phase 4: 会话管理 - SessionItem组件', () => {
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
    session: createMockSession(),
    isActive: false,
    onSelect: vi.fn(),
    onPin: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    global.confirm = vi.fn(() => true)
  })

  describe('TC-4.3 SessionItem 基本功能', () => {
    it('TC-4.3.1: 组件正常渲染', () => {
      const { container } = render(<SessionItem {...mockProps} />)
      expect(container.querySelector('.session-item')).toBeInTheDocument()
    })

    it('TC-4.3.2: 点击会话项触发选择回调', () => {
      render(<SessionItem {...mockProps} />)

      const sessionItem = screen.getByText('测试会话').closest('[role="button"]')
      fireEvent.click(sessionItem!)

      expect(mockProps.onSelect).toHaveBeenCalled()
    })

    it('TC-4.3.3: 激活状态添加active样式', () => {
      const { container } = render(<SessionItem {...mockProps} isActive={true} />)

      const sessionItem = container.querySelector('.session-item')
      expect(sessionItem).toHaveClass('active')
    })

    it('TC-4.3.4: 置顶状态添加pinned样式', () => {
      const session = createMockSession({ isPinned: true })
      const { container } = render(<SessionItem {...mockProps} session={session} />)

      const sessionItem = container.querySelector('.session-item')
      expect(sessionItem).toHaveClass('pinned')
    })

    it('TC-4.3.5: 显示会话标题', () => {
      render(<SessionItem {...mockProps} />)
      expect(screen.getByText('测试会话')).toBeInTheDocument()
    })

    it('TC-4.3.6: 不显示消息预览', () => {
      render(<SessionItem {...mockProps} />)
      expect(screen.queryByText(/Hello world/)).not.toBeInTheDocument()
    })

    it('TC-4.3.7: 运行中显示标题光波样式', () => {
      const session = createMockSession({ isStreaming: true })
      const { container } = render(<SessionItem {...mockProps} session={session} />)

      const sessionItem = container.querySelector('.session-item')
      expect(sessionItem).toHaveClass('streaming')
      expect(container.querySelector('.session-title--streaming')).toBeInTheDocument()
    })

    it('TC-4.3.8: 置顶会话显示图钉图标', () => {
      const session = createMockSession({ isPinned: true })
      const { container } = render(<SessionItem {...mockProps} session={session} />)

      expect(container.querySelector('.session-pin-icon')).toBeInTheDocument()
    })

    it('TC-4.3.9: 渲染 ··· 操作按钮', () => {
      render(<SessionItem {...mockProps} />)
      expect(screen.getByLabelText('会话操作')).toBeInTheDocument()
    })
  })

  describe('TC-4.3 ··· 操作菜单', () => {
    it('TC-4.3.1: 点击 ··· 打开菜单', () => {
      render(<SessionItem {...mockProps} />)

      fireEvent.click(screen.getByLabelText('会话操作'))

      expect(screen.getByText('置顶会话')).toBeInTheDocument()
      expect(screen.getByText('重命名')).toBeInTheDocument()
      expect(screen.getByText('删除会话')).toBeInTheDocument()
    })

    it('TC-4.3.2: 菜单内置顶触发回调且不选中会话', () => {
      render(<SessionItem {...mockProps} />)

      fireEvent.click(screen.getByLabelText('会话操作'))
      fireEvent.click(screen.getByText('置顶会话'))

      expect(mockProps.onPin).toHaveBeenCalled()
      expect(mockProps.onSelect).not.toHaveBeenCalled()
    })

    it('TC-4.3.3: 菜单内删除触发回调且不选中会话', () => {
      render(<SessionItem {...mockProps} />)

      fireEvent.click(screen.getByLabelText('会话操作'))
      fireEvent.click(screen.getByText('删除会话'))

      expect(mockProps.onDelete).toHaveBeenCalled()
      expect(mockProps.onSelect).not.toHaveBeenCalled()
    })
  })

  describe('TC-4.4 右键菜单', () => {
    it('TC-4.4.1: 右键点击显示上下文菜单', () => {
      const { container } = render(<SessionItem {...mockProps} />)

      const sessionItem = container.querySelector('.session-item')
      fireEvent.contextMenu(sessionItem!)

      expect(screen.getByText('重命名')).toBeInTheDocument()
      expect(screen.getByText('删除会话')).toBeInTheDocument()
    })

    it('TC-4.4.2: 菜单显示正确的置顶文本', () => {
      render(<SessionItem {...mockProps} />)

      const sessionItem = screen.getByText('测试会话').closest('[role="button"]')
      fireEvent.contextMenu(sessionItem!)

      expect(screen.getByText('置顶会话')).toBeInTheDocument()
    })

    it('TC-4.4.3: 已置顶会话菜单显示取消置顶', () => {
      const session = createMockSession({ isPinned: true })
      render(<SessionItem {...mockProps} session={session} />)

      const sessionItem = screen.getByText('测试会话').closest('[role="button"]')
      fireEvent.contextMenu(sessionItem!)

      expect(screen.getByText('取消置顶')).toBeInTheDocument()
    })
  })

  describe('TC-4.5 重命名功能', () => {
    it('TC-4.5.1: 点击重命名进入编辑模式', () => {
      render(<SessionItem {...mockProps} />)

      const sessionItem = screen.getByText('测试会话').closest('[role="button"]')
      fireEvent.contextMenu(sessionItem!)

      const renameBtn = screen.getByText('重命名')
      fireEvent.click(renameBtn)

      expect(screen.getByRole('textbox')).toBeInTheDocument()
    })

    it('TC-4.5.2: 编辑模式显示输入框', () => {
      const { container } = render(<SessionItem {...mockProps} />)

      const sessionItem = container.querySelector('.session-item')
      fireEvent.contextMenu(sessionItem!)

      const renameBtn = screen.getByText('重命名')
      fireEvent.click(renameBtn)

      const input = screen.getByRole('textbox') as HTMLInputElement
      expect(input.value).toBe('测试会话')
    })

    it('TC-4.5.3: 按Enter保存新标题', () => {
      render(<SessionItem {...mockProps} />)

      const sessionItem = screen.getByText('测试会话').closest('[role="button"]')
      fireEvent.contextMenu(sessionItem!)
      fireEvent.click(screen.getByText('重命名'))

      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '新标题' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockProps.onRename).toHaveBeenCalledWith('新标题')
    })

    it('TC-4.5.4: 按Escape取消编辑', () => {
      render(<SessionItem {...mockProps} />)

      const sessionItem = screen.getByText('测试会话').closest('[role="button"]')
      fireEvent.contextMenu(sessionItem!)
      fireEvent.click(screen.getByText('重命名'))

      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '新标题' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(mockProps.onRename).not.toHaveBeenCalled()
    })

    it('TC-4.5.5: 失焦保存标题', () => {
      render(<SessionItem {...mockProps} />)

      const sessionItem = screen.getByText('测试会话').closest('[role="button"]')
      fireEvent.contextMenu(sessionItem!)
      fireEvent.click(screen.getByText('重命名'))

      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '新标题' } })
      fireEvent.blur(input)

      expect(mockProps.onRename).toHaveBeenCalledWith('新标题')
    })

    it('TC-4.5.6: 空白标题不保存', () => {
      render(<SessionItem {...mockProps} />)

      const sessionItem = screen.getByText('测试会话').closest('[role="button"]')
      fireEvent.contextMenu(sessionItem!)
      fireEvent.click(screen.getByText('重命名'))

      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.blur(input)

      expect(mockProps.onRename).not.toHaveBeenCalled()
    })
  })
})
