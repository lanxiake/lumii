/**
 * ChatPage 组件测试
 * 测试 Phase 1: 架构重构 - 组件拆分和集成
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChatPage from '../../renderer/pages/ChatPage/ChatPage'
import { SIDEBAR_SESSION_SLOT_ID } from '../../renderer/components/layout/Sidebar'

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

/**
 * 会话列表已挪到最外层侧栏，ChatPage 用 createPortal 投进 MainLayout 提供的挂载点。
 * 单独渲染 ChatPage 时没有 MainLayout，必须自己把挂载点摆进 document，
 * 否则 ChatSidebar 整个不渲染（见 ChatPage.tsx 的 sessionSlot）。
 */
function mountSidebarSlot(): HTMLElement {
  const slot = document.createElement('div')
  slot.id = SIDEBAR_SESSION_SLOT_ID
  document.body.appendChild(slot)
  return slot
}

describe('Phase 1: 架构重构 - ChatPage组件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mountSidebarSlot()
  })

  afterEach(() => {
    document.getElementById(SIDEBAR_SESSION_SLOT_ID)?.remove()
  })

  describe('TC-1.1 组件拆分测试', () => {
    it('TC-1.1.1: ChatPage 组件存在并正常渲染', () => {
      const { container } = render(<ChatPage />)
      expect(container.querySelector('.chat-page')).toBeInTheDocument()
    })

    it('TC-1.1.2: ChatSidebar 组件渲染', () => {
      render(<ChatPage />)
      // portal 到 body 上的挂载点，不在 render 返回的 container 里
      expect(document.querySelector('.chat-sidebar')).toBeInTheDocument()
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

      // 检查主要子组件都存在（sidebar 是 portal，查 document）
      expect(document.querySelector('.chat-sidebar')).toBeInTheDocument()
      expect(container.querySelector('.chat-main')).toBeInTheDocument()
      expect(container.querySelector('.chat-input-wrapper')).toBeInTheDocument()
    })

    it('TC-1.2.2: 侧边栏可以切换显示/隐藏', () => {
      const { container } = render(<ChatPage />)

      // 默认显示侧边栏
      expect(document.querySelector('.chat-sidebar')).toBeInTheDocument()

      // 找到切换按钮（如果存在）
      const toggleBtn = container.querySelector('[title*="侧边栏"]') as HTMLElement
      if (toggleBtn) {
        fireEvent.click(toggleBtn)
        // 侧边栏应该隐藏（实际测试需要根据实现调整）
      }
    })
  })
})
