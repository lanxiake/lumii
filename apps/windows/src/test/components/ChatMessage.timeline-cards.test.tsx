/**
 * 时间线卡片注册表 — 集成级回归
 *
 * 两条护栏：
 * 1. **插件卡片抛错只毁自己那块**：卡片与宿主同上下文，渲染期抛错会一路冒到
 *    RootErrorBoundary → 整屏「页面加载失败」（PluginErrorBoundary 的注释记录了
 *    2026-10-21 的实测）。所以 chat 时间线里的卡片必须裹条目级边界。
 * 2. **注册表是卡片能被渲染的必要条件**：未注册的工具回落工具批次组，
 *    而不是静默消失。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ChatMessage } from '../../renderer/pages/ChatPage/components/ChatMessage'
import {
  ChatMessageActionsProvider,
  type ChatMessageActions,
} from '../../renderer/pages/ChatPage/contexts/ChatMessageActionsContext'
import {
  __resetTimelineCardsForTest,
  registerTimelineCard,
} from '../../renderer/pages/ChatPage/components/TimelineCards/registry'
import { registerBuiltinTimelineCards } from '../../renderer/pages/ChatPage/components/TimelineCards/builtin'
import type { AssistantPart } from '@mtbot/agent-runtime/browser'

const noop = () => {}
const actions: ChatMessageActions = {
  formatTime: () => '10:00',
  copyMessage: noop,
  editMessage: noop,
  deleteMessage: noop,
  regenerateMessage: noop,
  replayFromMessage: noop,
  reviewFileChanges: noop,
  confirmHandoff: async () => ({ ok: true }),
  openSession: noop,
  forkMessage: noop,
}

function renderWith(parts: AssistantPart[]) {
  return render(
    <ChatMessageActionsProvider value={actions}>
      <ChatMessage
        message={{
          id: 'm-1',
          role: 'assistant',
          content: '',
          timestamp: new Date('2026-10-24T10:00:00'),
          parts,
        }}
      />
    </ChatMessageActionsProvider>,
  )
}

const textPart: AssistantPart = { type: 'text', id: 'tx-1', text: 'MARKER_ANSWER', status: 'done' }

describe('时间线卡片 · 插件隔离', () => {
  beforeEach(() => {
    __resetTimelineCardsForTest()
    registerBuiltinTimelineCards()
  })

  it('插件卡片渲染抛错时，同一条气泡的其他内容照常可见', () => {
    // React 会把 catch 到的错误打到 console.error；这里抑制掉，避免测试输出被噪声淹
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerTimelineCard({
      id: 'test.broken',
      match: (p) => p.name === 'evil_tool',
      component: () => {
        throw new Error('BOOM plugin card')
      },
      owner: 'test.plugin',
    })

    const { container } = renderWith([
      { type: 'tool', id: 't-1', name: 'evil_tool', args: {}, status: 'done' },
      textPart,
    ])

    expect(container.textContent).toContain('MARKER_ANSWER')
    // 边界给的是「谁坏了」而不是白屏
    expect(container.textContent).toContain('渲染失败')

    spy.mockRestore()
  })

  it('未注册的普通工具回落工具批次组，不会静默消失', () => {
    const { container } = renderWith([
      { type: 'tool', id: 't-1', name: 'file_read', args: {}, status: 'done' },
    ])
    expect(container.textContent).toContain('读取 1 个文件')
  })
})
