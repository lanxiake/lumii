/**
 * ChatContainer「回到产生它的那条消息」。
 *
 * 守的三条：未渲染但还有历史时自动翻页后定位；定位后高亮 class 出现并在 1.6s 后消失；
 * 翻到底仍找不到时也要回调 onFocusHandled（否则焦点请求会一直吊着，下次点击无效）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'
import { ChatContainer } from '../../renderer/pages/ChatPage/components/ChatContainer'
import {
  ChatMessageActionsProvider,
  type ChatMessageActions,
} from '../../renderer/pages/ChatPage/contexts/ChatMessageActionsContext'
import type { ChatSession } from '../../renderer/hooks/business/useChat'

global.window.electronAPI = {} as never

const scrollIntoView = vi.fn()
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView
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
  forkMessage: noop,
}

type Msg = ChatSession['messages'][number]

function message(id: string, role: 'user' | 'assistant', content: string): Msg {
  return { id, role, content, timestamp: new Date('2026-01-01T10:00:00') } as Msg
}

function makeSession(messages: Msg[]): ChatSession {
  return {
    id: 's-1',
    title: '测试会话',
    messages,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    source: 'local',
  }
}

interface RenderArgs {
  session: ChatSession
  focusMessageId?: string | null
  hasMoreHistory?: boolean
  onLoadOlderMessages?: () => void
  onFocusHandled?: () => void
}

function renderContainer(args: RenderArgs) {
  return render(
    <ChatMessageActionsProvider value={messageActions}>
      <ChatContainer
        session={args.session}
        workflowItems={[]}
        isLoading={false}
        isStreaming={false}
        isSending={false}
        focusMessageId={args.focusMessageId ?? null}
        {...(args.hasMoreHistory !== undefined ? { hasMoreHistory: args.hasMoreHistory } : {})}
        {...(args.onLoadOlderMessages ? { onLoadOlderMessages: args.onLoadOlderMessages } : {})}
        {...(args.onFocusHandled ? { onFocusHandled: args.onFocusHandled } : {})}
      />
    </ChatMessageActionsProvider>,
  )
}

describe('ChatContainer focusMessageId', () => {
  beforeEach(() => {
    scrollIntoView.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('已渲染的目标行：滚到中间并加高亮，然后回调清空焦点', async () => {
    const onFocusHandled = vi.fn()
    const { container } = renderContainer({
      session: makeSession([
        message('m1', 'user', '第一句'),
        message('m2', 'assistant', '回答'),
      ]),
      focusMessageId: 'm1',
      onFocusHandled,
    })

    await waitFor(() => expect(onFocusHandled).toHaveBeenCalled())
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    // 高亮挂在行容器上（data-row-key 由窗口化 hook 写入）
    await waitFor(() => {
      const row = container.querySelector('[data-row-key="m:m1"]')
      expect(row?.className).toMatch(/focused/)
    })
  })

  it('目标未渲染但还有历史 → 先翻页；翻到后不再重复翻', async () => {
    const onLoadOlderMessages = vi.fn()
    const onFocusHandled = vi.fn()
    const messages = [message('m1', 'user', '第一句')]
    const { rerender, container } = renderContainer({
      session: makeSession(messages),
      focusMessageId: 'old-1',
      hasMoreHistory: true,
      onLoadOlderMessages,
      onFocusHandled,
    })

    await waitFor(() => expect(onLoadOlderMessages).toHaveBeenCalledTimes(1))
    expect(onFocusHandled).not.toHaveBeenCalled()

    // 上一页插进来后目标行出现 → 定位并收尾
    rerender(
      <ChatMessageActionsProvider value={messageActions}>
        <ChatContainer
          session={makeSession([message('old-1', 'user', '更早'), ...messages])}
          workflowItems={[]}
          isLoading={false}
          isStreaming={false}
          isSending={false}
          focusMessageId="old-1"
          hasMoreHistory
          onLoadOlderMessages={onLoadOlderMessages}
          onFocusHandled={onFocusHandled}
        />
      </ChatMessageActionsProvider>,
    )
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalled())
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-row-key="m:old-1"]')).toBeInTheDocument()
  })

  it('翻到底仍找不到（已删除/被压缩）：也要回调 onFocusHandled，不留悬挂请求', async () => {
    const onFocusHandled = vi.fn()
    renderContainer({
      session: makeSession([message('m1', 'user', '仅有的消息')]),
      focusMessageId: 'gone',
      hasMoreHistory: false,
      onFocusHandled,
    })
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalled())
    // 挂载时会滚到底部（'auto'），但定位用的 'center' 一次都不该出现
    expect(scrollIntoView.mock.calls.some(([arg]) => arg && arg.block === 'center')).toBe(false)
  })

  it('高亮 1.6s 后自动褪去', async () => {
    const { container } = renderContainer({
      session: makeSession([message('m1', 'user', '第一句')]),
      focusMessageId: 'm1',
      onFocusHandled: vi.fn(),
    })
    await waitFor(() =>
      expect(container.querySelector('[data-row-key="m:m1"]')?.className).toMatch(/focused/),
    )
    await waitFor(
      () =>
        expect(container.querySelector('[data-row-key="m:m1"]')?.className).not.toMatch(/focused/),
      { timeout: 3000 },
    )
  })
})
