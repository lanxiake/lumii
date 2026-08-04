/**
 * MessageActions 组件测试
 * 测试 Phase 3: 消息功能增强 - 消息操作
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import MessageActions from '../../renderer/pages/ChatPage/components/MessageActions'

describe('Phase 3: 消息功能 - MessageActions组件', () => {
  const mockProps = {
    messageId: 'msg-123',
    role: 'user' as const,
    content: 'Test message content',
    isEditing: false,
    onCopy: vi.fn(),
    onEditStart: vi.fn(),
    onEditCancel: vi.fn(),
    onEditSave: vi.fn(),
    onDelete: vi.fn(),
    onRegenerate: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(),
      },
    })
    // Mock confirm dialog
    global.confirm = vi.fn(() => true)
  })

  describe('TC-3.1 MessageActions 基本功能', () => {
    it('TC-3.1.1: 组件正常渲染操作按钮', () => {
      const { container } = render(<MessageActions {...mockProps} />)
      expect(container.querySelector('.message-actions')).toBeInTheDocument()
    })

    it('TC-3.1.2: 点击"复制"按钮触发回调', () => {
      render(<MessageActions {...mockProps} />)

      const copyBtn = screen.getByTitle('复制')
      fireEvent.click(copyBtn)

      expect(mockProps.onCopy).toHaveBeenCalledWith(mockProps.content)
    })

    it('TC-3.1.3: user消息显示"编辑"按钮', () => {
      render(<MessageActions {...mockProps} role="user" />)

      const editBtn = screen.getByTitle('编辑')
      expect(editBtn).toBeInTheDocument()
    })

    it('TC-3.1.4: 点击"编辑"按钮进入编辑模式', () => {
      render(<MessageActions {...mockProps} role="user" />)

      const editBtn = screen.getByTitle('编辑')
      fireEvent.click(editBtn)

      expect(mockProps.onEditStart).toHaveBeenCalled()
    })

    it('TC-3.1.5: 编辑模式显示编辑框和保存/取消按钮', () => {
      const { container } = render(<MessageActions {...mockProps} isEditing={true} />)

      expect(container.querySelector('.message-edit-mode')).toBeInTheDocument()
      expect(container.querySelector('.edit-textarea')).toBeInTheDocument()
      expect(screen.getByText('保存')).toBeInTheDocument()
      expect(screen.getByText('取消')).toBeInTheDocument()
    })

    it('TC-3.1.6: 编辑模式下点击保存触发回调', () => {
      render(<MessageActions {...mockProps} isEditing={true} />)

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'New content' } })

      const saveBtn = screen.getByText('保存')
      fireEvent.click(saveBtn)

      expect(mockProps.onEditSave).toHaveBeenCalledWith('New content')
    })

    it('TC-3.1.7: 编辑模式下点击取消触发回调', () => {
      render(<MessageActions {...mockProps} isEditing={true} />)

      const cancelBtn = screen.getByText('取消')
      fireEvent.click(cancelBtn)

      expect(mockProps.onEditCancel).toHaveBeenCalled()
    })

    it('TC-3.1.8: 点击"删除"按钮显示确认对话框', () => {
      render(<MessageActions {...mockProps} />)

      const deleteBtn = screen.getByTitle('删除')
      fireEvent.click(deleteBtn)

      expect(global.confirm).toHaveBeenCalled()
    })

    it('TC-3.1.9: 确认删除后触发回调', () => {
      global.confirm = vi.fn(() => true)
      render(<MessageActions {...mockProps} />)

      const deleteBtn = screen.getByTitle('删除')
      fireEvent.click(deleteBtn)

      expect(mockProps.onDelete).toHaveBeenCalledWith(mockProps.messageId)
    })

    it('TC-3.1.10: 取消删除不触发回调', () => {
      global.confirm = vi.fn(() => false)
      render(<MessageActions {...mockProps} />)

      const deleteBtn = screen.getByTitle('删除')
      fireEvent.click(deleteBtn)

      expect(mockProps.onDelete).not.toHaveBeenCalled()
    })

    it('TC-3.1.11: user 和 assistant 消息都显示"重新生成"按钮', () => {
      const { rerender } = render(<MessageActions {...mockProps} role="user" />)
      expect(screen.getByTitle('重新生成')).toBeInTheDocument()

      rerender(<MessageActions {...mockProps} role="assistant" />)
      expect(screen.getByTitle('重新生成')).toBeInTheDocument()
    })

    it('TC-3.1.12: 点击"重新生成"触发回调', () => {
      render(<MessageActions {...mockProps} role="assistant" />)

      const regenerateBtn = screen.getByTitle('重新生成')
      fireEvent.click(regenerateBtn)

      expect(mockProps.onRegenerate).toHaveBeenCalledWith(mockProps.messageId)
    })

    it('TC-3.1.13: assistant消息不显示"编辑"按钮', () => {
      render(<MessageActions {...mockProps} role="assistant" />)

      expect(screen.queryByTitle('编辑')).not.toBeInTheDocument()
    })

    it('TC-3.1.14: sessionBusy 时"重新生成"按钮禁用', () => {
      render(<MessageActions {...mockProps} role="assistant" sessionBusy={true} />)

      const regenerateBtn = screen.getByTitle('正在回复中…')
      expect(regenerateBtn).toBeDisabled()
    })
  })
})
