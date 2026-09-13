/**
 * ChatMessage parts 时间线渲染测试
 * 验证 thinking / tool / text 按 parts 顺序交错出现在 DOM 中
 */

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ChatMessage } from '../../renderer/pages/ChatPage/components/ChatMessage'
import {
  ChatMessageActionsProvider,
  type ChatMessageActions,
} from '../../renderer/pages/ChatPage/contexts/ChatMessageActionsContext'
import type { ChatMessage as ChatMessageType } from '../../renderer/hooks/business/useChat'
import type { AssistantPart } from '@mtbot/agent-runtime/browser'

const noop = vi.fn()

/** 消息级交互动作已收敛到 Context（原先由 props 逐个传入） */
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

/** 构造带 4 段 parts 的助手消息（thinking → tool → text → text） */
function buildPartsMessage(parts: AssistantPart[]): ChatMessageType {
  return {
    id: 'msg-parts-1',
    role: 'assistant',
    content: parts
      .filter((p): p is Extract<AssistantPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n'),
    timestamp: new Date('2026-08-08T10:00:00'),
    parts,
  }
}

describe('ChatMessage parts 时间线', () => {
  it('中间过程（思考+工具）折叠进过程区摘要，末尾两段 text 作为答案露在折叠块外', () => {
    // 新行为：思考 + 工具 = 过程区，默认折叠进 ActivityFold（收起时不渲染详情），
    // 摘要行显示「💭 思考 · 调用 1 次工具」；末尾连续 text 为答案区，直接可见且保持顺序。
    const parts: AssistantPart[] = [
      { type: 'thinking', id: 'th-1', text: 'MARKER_ALPHA_THINK', status: 'done' },
      { type: 'tool', id: 'tool-1', name: 'MARKER_BETA_TOOL', args: {}, status: 'done' },
      { type: 'text', id: 'tx-1', text: 'MARKER_GAMMA_TEXT', status: 'done' },
      { type: 'text', id: 'tx-2', text: 'MARKER_DELTA_TEXT', status: 'done' },
    ]

    const { container } = render(
      <ChatMessageActionsProvider value={messageActions}>
        <ChatMessage message={buildPartsMessage(parts)} />
      </ChatMessageActionsProvider>,
    )

    const text = container.textContent ?? ''
    // 过程区摘要包含思考前缀与工具计数（已去掉表情符号）
    const idxSummary = text.indexOf('思考 · 调用 1 次工具')
    const idxGamma = text.indexOf('MARKER_GAMMA_TEXT')
    const idxDelta = text.indexOf('MARKER_DELTA_TEXT')

    expect(idxSummary).toBeGreaterThanOrEqual(0)
    // 折叠默认收起：思考原文与工具名不出现在 DOM
    expect(text.indexOf('MARKER_ALPHA_THINK')).toBe(-1)
    expect(text.indexOf('MARKER_BETA_TOOL')).toBe(-1)
    // 答案区在过程摘要之后，且两段 text 保持顺序
    expect(idxGamma).toBeGreaterThan(idxSummary)
    expect(idxDelta).toBeGreaterThan(idxGamma)
  })

  it('多个连续工具折叠为一个批次分组，默认不展开工具名', () => {
    const parts: AssistantPart[] = [
      { type: 'tool', id: 't1', name: 'file_read', args: {}, status: 'done' },
      { type: 'tool', id: 't2', name: 'file_read', args: {}, status: 'done' },
      { type: 'tool', id: 't3', name: 'grep', args: {}, status: 'done' },
    ]

    const { getByText } = render(
      <ChatMessageActionsProvider value={messageActions}>
        <ChatMessage message={buildPartsMessage(parts)} />
      </ChatMessageActionsProvider>,
    )

    // 摘要按家族计数：读取 2 个文件 · 搜索 1 次
    expect(getByText('读取 2 个文件 · 搜索 1 次')).toBeInTheDocument()
  })

  it('空 parts 且流式中时显示正在思考占位', () => {
    const { getByText } = render(
      <ChatMessageActionsProvider value={messageActions}>
        <ChatMessage
          message={{
            id: 'msg-stream',
            role: 'assistant',
            content: '',
            timestamp: new Date(),
            isStreaming: true,
            parts: [],
          }}
        />
      </ChatMessageActionsProvider>,
    )

    expect(getByText(/正在思考/)).toBeInTheDocument()
  })

  it('转交卡片（propose_dev_handoff）永远露在折叠区外：确认按钮默认可见', () => {
    // 回归护栏（F2）：propose 之后模型还会有一段 thinking，若按「最后一个 thinking 划过程区」
    // 的规则会把卡片折叠进 ActivityFold（收起时不渲染 children）→ 用户点不到。
    const parts: AssistantPart[] = [
      { type: 'thinking', id: 'th-1', text: 'MARKER_THINK_A', status: 'done' },
      { type: 'tool', id: 'tool-1', name: 'file_read', args: {}, status: 'done' },
      { type: 'thinking', id: 'th-2', text: 'MARKER_THINK_B', status: 'done' },
      {
        type: 'tool',
        id: 't-handoff',
        name: 'propose_dev_handoff',
        args: { summary: '修复分页 off-by-one' },
        status: 'done',
        result: {
          content: [
            { type: 'text', text: JSON.stringify({ status: 'proposed', handoffId: 'h-1' }) },
          ],
        },
      },
      { type: 'thinking', id: 'th-3', text: 'MARKER_THINK_C', status: 'done' },
      { type: 'text', id: 'tx-1', text: 'MARKER_FINAL', status: 'done' },
    ]

    const { getByRole, container } = render(
      <ChatMessageActionsProvider value={messageActions}>
        <ChatMessage message={buildPartsMessage(parts)} />
      </ChatMessageActionsProvider>,
    )

    // 折叠区仍然收起（思考原文不进 DOM）
    expect(container.textContent ?? '').not.toContain('MARKER_THINK_A')
    // 但卡片与确认按钮必须可见可点
    expect(getByRole('button', { name: '交给灵栖开发' })).toBeInTheDocument()
    expect(container.textContent ?? '').toContain('修复分页 off-by-one')
  })
})
