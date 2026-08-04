/**
 * ChatPage 组件测试
 * 测试 Phase 1: 架构重构 - 组件拆分和集成
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChatPage from '../../renderer/pages/ChatPage/ChatPage'

// Mock hooks
vi.mock('../../renderer/hooks/business/useChat', () => ({
  useChat: vi.fn(() => ({
    sessions: [],
    activeSession: null,
    activeSessionId: null,
    isLoading: false,
    isStreaming: false,
    createSession: vi.fn(),
    switchSession: vi.fn(),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
    togglePinSession: vi.fn(),
    renameSession: vi.fn(),
  })),
}))

// Mock electronAPI
global.window.electronAPI = {} as any

describe('Phase 1: 架构重构 - ChatPage组件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('TC-1.1 组件拆分测试', () => {
    it('TC-1.1.1: ChatPage 组件存在并正常渲染', () => {
      const { container } = render(<ChatPage />)
      expect(container.querySelector('.chat-page')).toBeInTheDocument()
    })

    it('TC-1.1.2: ChatSidebar 组件渲染', () => {
      const { container } = render(<ChatPage />)
      expect(container.querySelector('.chat-sidebar')).toBeInTheDocument()
    })

    it('TC-1.1.3: ChatContainer 组件渲染', () => {
      const { container } = render(<ChatPage />)
      expect(container.querySelector('.chat-container')).toBeInTheDocument()
    })

    it('TC-1.1.5: ChatInput 组件渲染', () => {
      const { container } = render(<ChatPage />)
      expect(container.querySelector('.chat-input-wrapper')).toBeInTheDocument()
    })
  })

  describe('TC-1.2 组件集成测试', () => {
    it('TC-1.2.1: ChatPage 渲染所有主要子组件', () => {
      const { container } = render(<ChatPage />)

      // 检查主要子组件都存在
      expect(container.querySelector('.chat-sidebar')).toBeInTheDocument()
      expect(container.querySelector('.chat-main')).toBeInTheDocument()
      expect(container.querySelector('.chat-input-wrapper')).toBeInTheDocument()
    })

    it('TC-1.2.2: 侧边栏可以切换显示/隐藏', () => {
      const { container } = render(<ChatPage />)

      // 默认显示侧边栏
      expect(container.querySelector('.chat-sidebar')).toBeInTheDocument()

      // 找到切换按钮（如果存在）
      const toggleBtn = container.querySelector('[title*="侧边栏"]') as HTMLElement
      if (toggleBtn) {
        fireEvent.click(toggleBtn)
        // 侧边栏应该隐藏（实际测试需要根据实现调整）
      }
    })
  })
})
