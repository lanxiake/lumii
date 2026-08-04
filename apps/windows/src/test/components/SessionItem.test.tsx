/**
 * SessionItem 组件测试
 * 测试 Phase 4: 会话管理增强 - 悬停操作/右键菜单/重命名
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

      const sessionItem = screen.getByText('测试会话').closest('button')
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

    it('TC-4.3.6: 显示最后消息预览', () => {
      render(<SessionItem {...mockProps} />)
      expect(screen.getByText(/Hello world/)).toBeInTheDocument()
    })

    it('TC-4.3.7: 无消息时显示默认提示', () => {
      const session = createMockSession({ messages: [] })
      render(<SessionItem {...mockProps} session={session} />)
      expect(screen.getByText('暂无消息')).toBeInTheDocument()
    })

    it('TC-4.3.8: 超长预览文本截断显示', () => {
      const longContent = 'A'.repeat(50)
      const session = createMockSession({
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: longContent,
            timestamp: new Date(),
          },
        ],
      })
      render(<SessionItem {...mockProps} session={session} />)

      const preview = screen.getByText(/\.\.\./)
      expect(preview.textContent!.length).toBeLessThanOrEqual(35) // 30 + "..."
    })

    it('TC-4.3.9: 置顶会话显示图钉图标', () => {
      const session = createMockSession({ isPinned: true })
      const { container } = render(<SessionItem {...mockProps} session={session} />)

      expect(container.querySelector('.session-pin-icon')).toBeInTheDocument()
    })
  })

  describe('TC-4.3 悬停操作按钮', () => {
    it('TC-4.3.1: 点击置顶按钮触发回调', () => {
      const { container } = render(<SessionItem {...mockProps} />)

      const pinBtn = container.querySelector('.session-action-btn')
      fireEvent.click(pinBtn!)

      expect(mockProps.onPin).toHaveBeenCalled()
    })

    it('TC-4.3.2: 点击删除按钮触发回调', () => {
      const { container } = render(<SessionItem {...mockProps} />)

      const deleteBtn = container.querySelector('.session-action-btn.delete')
      fireEvent.click(deleteBtn!)

      expect(mockProps.onDelete).toHaveBeenCalled()
    })

    it('TC-4.3.3: 操作按钮点击不触发选择', () => {
      const { container } = render(<SessionItem {...mockProps} />)

      const pinBtn = container.querySelector('.session-action-btn')
      fireEvent.click(pinBtn!)

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

      const sessionItem = screen.getByText('测试会话').closest('button')
      fireEvent.contextMenu(sessionItem!)

      expect(screen.getByText('置顶会话')).toBeInTheDocument()
    })

    it('TC-4.4.3: 已置顶会话菜单显示取消置顶', () => {
      const session = createMockSession({ isPinned: true })
      render(<SessionItem {...mockProps} session={session} />)

      const sessionItem = screen.getByText('测试会话').closest('button')
      fireEvent.contextMenu(sessionItem!)

      expect(screen.getByText('取消置顶')).toBeInTheDocument()
    })
  })

  describe('TC-4.5 重命名功能', () => {
    it('TC-4.5.1: 点击重命名进入编辑模式', () => {
      render(<SessionItem {...mockProps} />)

      const sessionItem = screen.getByText('测试会话').closest('button')
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

      const sessionItem = screen.getByText('测试会话').closest('button')
      fireEvent.contextMenu(sessionItem!)
      fireEvent.click(screen.getByText('重命名'))

      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '新标题' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockProps.onRename).toHaveBeenCalledWith('新标题')
    })

    it('TC-4.5.4: 按Escape取消编辑', () => {
      render(<SessionItem {...mockProps} />)

      const sessionItem = screen.getByText('测试会话').closest('button')
      fireEvent.contextMenu(sessionItem!)
      fireEvent.click(screen.getByText('重命名'))

      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '新标题' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(mockProps.onRename).not.toHaveBeenCalled()
    })

    it('TC-4.5.5: 失焦保存标题', () => {
      render(<SessionItem {...mockProps} />)

      const sessionItem = screen.getByText('测试会话').closest('button')
      fireEvent.contextMenu(sessionItem!)
      fireEvent.click(screen.getByText('重命名'))

      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '新标题' } })
      fireEvent.blur(input)

      expect(mockProps.onRename).toHaveBeenCalledWith('新标题')
    })

    it('TC-4.5.6: 空白标题不保存', () => {
      render(<SessionItem {...mockProps} />)

      const sessionItem = screen.getByText('测试会话').closest('button')
      fireEvent.contextMenu(sessionItem!)
      fireEvent.click(screen.getByText('重命名'))

      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.blur(input)

      expect(mockProps.onRename).not.toHaveBeenCalled()
    })
  })
})
