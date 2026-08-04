/**
 * ChatInput 组件测试
 * 测试 Phase 3: 消息功能增强 - 自动高度输入框
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChatInput from '../../renderer/pages/ChatPage/components/ChatInput'

describe('Phase 3: 消息功能 - ChatInput组件', () => {
  const mockProps = {
    value: '',
    onChange: vi.fn(),
    onSend: vi.fn(),
    disabled: false,
    isStreaming: false,
    isConnected: true,
    placeholder: '输入消息...',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('TC-3.2 自动高度输入框功能', () => {
    it('TC-3.2.1: 组件正常渲染', () => {
      const { container } = render(<ChatInput {...mockProps} />)
      expect(container.querySelector('.chat-input-wrapper')).toBeInTheDocument()
      expect(container.querySelector('.chat-textarea')).toBeInTheDocument()
    })

    it('TC-3.2.2: 输入文本触发onChange回调', () => {
      render(<ChatInput {...mockProps} />)

      const textarea = screen.getByPlaceholderText('输入消息...') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'Test message' } })

      expect(mockProps.onChange).toHaveBeenCalledWith('Test message')
    })

    it('TC-3.2.3: 按Enter键发送消息（非Shift+Enter）', () => {
      render(<ChatInput {...mockProps} value="Test message" />)

      const textarea = screen.getByPlaceholderText('输入消息...') as HTMLTextAreaElement
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

      expect(mockProps.onSend).toHaveBeenCalled()
    })

    it('TC-3.2.4: 按Shift+Enter不发送消息（插入换行）', () => {
      render(<ChatInput {...mockProps} value="Test message" />)

      const textarea = screen.getByPlaceholderText('输入消息...') as HTMLTextAreaElement
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

      expect(mockProps.onSend).not.toHaveBeenCalled()
    })

    it('TC-3.2.5: 空白内容按Enter不发送', () => {
      render(<ChatInput {...mockProps} value="   " />)

      const textarea = screen.getByPlaceholderText('输入消息...') as HTMLTextAreaElement
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

      expect(mockProps.onSend).not.toHaveBeenCalled()
    })

    it('TC-3.2.6: 点击发送按钮触发发送', () => {
      render(<ChatInput {...mockProps} value="Test message" />)

      const sendBtn = screen.getByRole('button')
      fireEvent.click(sendBtn)

      expect(mockProps.onSend).toHaveBeenCalled()
    })

    it('TC-3.2.7: 连接断开时输入框禁用', () => {
      render(<ChatInput {...mockProps} isConnected={false} />)

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      expect(textarea).toBeDisabled()
    })

    it('TC-3.2.8: 流式生成时发送按钮显示停止图标', () => {
      render(<ChatInput {...mockProps} isStreaming={true} />)

      const sendBtn = screen.getByRole('button')
      expect(sendBtn.textContent).toContain('⏹️')
    })

    it('TC-3.2.9: 非流式时发送按钮显示发送图标', () => {
      render(<ChatInput {...mockProps} isStreaming={false} />)

      const sendBtn = screen.getByRole('button')
      expect(sendBtn.textContent).toContain('➤')
    })

    it('TC-3.2.10: 禁用时发送按钮不可点击', () => {
      render(<ChatInput {...mockProps} disabled={true} />)

      const sendBtn = screen.getByRole('button')
      expect(sendBtn).toBeDisabled()
    })

    it('TC-3.2.11: 未连接时显示警告提示', () => {
      render(<ChatInput {...mockProps} isConnected={false} />)

      expect(screen.getByText(/未连接到服务器/)).toBeInTheDocument()
    })

    it('TC-3.2.12: 流式生成时显示生成中提示', () => {
      render(<ChatInput {...mockProps} isStreaming={true} />)

      expect(screen.getByText(/生成中.../)).toBeInTheDocument()
    })

    it('TC-3.2.13: 正常状态显示快捷键提示', () => {
      render(<ChatInput {...mockProps} />)

      expect(screen.getByText(/Enter 发送，Shift\+Enter 换行/)).toBeInTheDocument()
    })

    it('TC-3.2.14: 空白内容发送按钮禁用', () => {
      render(<ChatInput {...mockProps} value="" />)

      const sendBtn = screen.getByRole('button')
      expect(sendBtn).toBeDisabled()
    })
  })
})
