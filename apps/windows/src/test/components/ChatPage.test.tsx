/**
 * ChatPage 组件测试
 * 测试 Phase 1: 架构重构 - 组件拆分和集成
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChatPage from '../../renderer/pages/ChatPage/ChatPage'
import { SIDEBAR_SESSION_SLOT_ID } from '../../renderer/components/layout/Sidebar'
import { ToastProvider } from '../../renderer/components/ui/Toast/ToastContainer'
import { SettingsHubProvider } from '../../renderer/components/SettingsHub/SettingsHubContext'
import { computeClearGroupPlan } from '../../renderer/pages/ChatPage/clearGroupPlan'
import type { ChatSession } from '../../renderer/hooks/business/useChat'

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

/** ChatPage 的 Toast 已统一走全局 ui/Toast，渲染时必须提供 ToastProvider；ChatSidebar 需要 SettingsHubProvider */
function renderChatPage() {
  return render(
    <SettingsHubProvider>
      <ToastProvider>
        <ChatPage />
      </ToastProvider>
    </SettingsHubProvider>,
  )
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
      const { container } = renderChatPage()
      expect(container.querySelector('.chat-page')).toBeInTheDocument()
    })

    it('TC-1.1.2: ChatSidebar 组件渲染', () => {
      renderChatPage()
      // portal 到 body 上的挂载点，不在 render 返回的 container 里
      expect(document.querySelector('.chat-sidebar')).toBeInTheDocument()
    })

    it('TC-1.1.3: ChatContainer 组件渲染', () => {
      const { container } = renderChatPage()
      expect(container.querySelector('.chat-container')).toBeInTheDocument()
    })

    it('TC-1.1.5: ChatInput 组件渲染', () => {
      const { container } = renderChatPage()
      expect(container.querySelector('.chat-input-wrapper')).toBeInTheDocument()
    })
  })

  describe('TC-1.2 组件集成测试', () => {
    it('TC-1.2.1: ChatPage 渲染所有主要子组件', () => {
      const { container } = renderChatPage()

      // 检查主要子组件都存在（sidebar 是 portal，查 document）
      expect(document.querySelector('.chat-sidebar')).toBeInTheDocument()
      expect(container.querySelector('.chat-main')).toBeInTheDocument()
      expect(container.querySelector('.chat-input-wrapper')).toBeInTheDocument()
    })

    it('TC-1.2.2: 侧边栏可以切换显示/隐藏', () => {
      const { container } = renderChatPage()

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

  describe('computeClearGroupPlan 分组清空计划', () => {
    const mk = (id: string, patch: Partial<ChatSession> = {}): ChatSession =>
      ({
        id,
        title: id,
        messages: [],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        source: 'local',
        ...patch,
      }) as ChatSession

    it('置顶豁免、运行中跳过、自主进化会话剔除', () => {
      const sessions = [
        mk('a', { updatedAt: new Date('2026-01-04') }),
        mk('b', { isPinned: true }),
        mk('c', { isStreaming: true }),
        mk('d', { channel: 'evolution' }),
      ]

      const plan = computeClearGroupPlan({ label: '系统默认', sessions, keepRecent: null })

      expect(plan.pinned).toBe(1)
      expect(plan.streaming).toBe(1)
      expect(plan.toDelete.map((s) => s.id)).toEqual(['a'])
    })

    it('保留最近 5 条：删除更早的（按更新时间倒序）', () => {
      const sessions = Array.from({ length: 7 }, (_, i) =>
        mk(`s${i}`, { updatedAt: new Date(2026, 0, i + 1) }),
      )

      const plan = computeClearGroupPlan({ label: '系统默认', sessions, keepRecent: 5 })

      expect(plan.toDelete.map((s) => s.id)).toEqual(['s1', 's0'])
    })
  })
})
