/**
 * ChatContainer 状态切换回归
 *
 * 回归背景：「执行过程」折叠态进度联动给 ChatContainer 新增了一个 useMemo，
 * 它曾被放在「空列表提前 return」之后 —— 于是空会话渲染时 hooks 数量少、
 * 有消息时又多一个，React 抛 "Rendered more hooks than during the previous render"，
 * 整个聊天界面加载失败。此用例锁定：空列表 → 有消息的切换不得报错。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ChatContainer } from '../../renderer/pages/ChatPage/components/ChatContainer'
import {
  ChatMessageActionsProvider,
  type ChatMessageActions,
} from '../../renderer/pages/ChatPage/contexts/ChatMessageActionsContext'
import type { ChatSession } from '../../renderer/hooks/business/useChat'

global.window.electronAPI = {} as never

// jsdom 未实现 scrollIntoView，ChatContainer 滚到底部时会调用
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const noop = vi.fn()
const messageActions: ChatMessageActions = {
  formatTime: () => '10:00',
  copyMessage: noop,
  editMessage: noop,
  deleteMessage: noop,
  regenerateMessage: noop,
  replayFromMessage: noop,
  reviewFileChanges: noop,
  confirmHandoff: vi.fn(async () => ({ ok: true })),
  openSession: noop,
}

function makeSession(messages: ChatSession['messages']): ChatSession {
  return {
    id: 's-1',
    title: '测试会话',
    messages,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    source: 'local',
  }
}

function renderContainer(session: ChatSession | null) {
  return render(
    <ChatMessageActionsProvider value={messageActions}>
      <ChatContainer
        session={session}
        workflowItems={[]}
        isLoading={false}
        isStreaming={false}
        isSending={false}
      />
    </ChatMessageActionsProvider>,
  )
}

describe('ChatContainer 状态切换', () => {
  it('空列表切到有消息不触发 hooks 顺序错误', () => {
    const { rerender } = renderContainer(makeSession([]))
    expect(document.querySelector('.chat-container')).toBeInTheDocument()

    const withMessage = makeSession([
      {
        id: 'm-1',
        role: 'assistant',
        content: '你好',
        timestamp: new Date('2026-01-01T10:00:00'),
      },
    ])

    expect(() =>
      rerender(
        <ChatMessageActionsProvider value={messageActions}>
          <ChatContainer
            session={withMessage}
            workflowItems={[]}
            isLoading={false}
            isStreaming={false}
            isSending={false}
          />
        </ChatMessageActionsProvider>,
      ),
    ).not.toThrow()
  })
})
