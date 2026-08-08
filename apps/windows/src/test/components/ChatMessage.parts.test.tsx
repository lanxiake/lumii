/**
 * ChatMessage parts 时间线渲染测试
 * 验证 thinking / tool / text 按 parts 顺序交错出现在 DOM 中
 */

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ChatMessage } from '../../renderer/pages/ChatPage/components/ChatMessage'
import type { ChatMessage as ChatMessageType } from '../../renderer/hooks/business/useChat'
import type { AssistantPart } from '@mtbot/agent-runtime'

const noop = vi.fn()

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
  it('按 thinking、tool、两段 text 的 parts 顺序渲染 DOM', () => {
    const parts: AssistantPart[] = [
      { type: 'thinking', id: 'th-1', text: 'MARKER_ALPHA_THINK', status: 'done' },
      { type: 'tool', id: 'tool-1', name: 'MARKER_BETA_TOOL', args: {}, status: 'done' },
      { type: 'text', id: 'tx-1', text: 'MARKER_GAMMA_TEXT', status: 'done' },
      { type: 'text', id: 'tx-2', text: 'MARKER_DELTA_TEXT', status: 'done' },
    ]

    const { container } = render(
      <ChatMessage
        message={buildPartsMessage(parts)}
        formatTime={() => '10:00'}
        onCopy={noop}
        onEdit={noop}
        onDelete={noop}
        onRegenerate={noop}
      />,
    )

    const text = container.textContent ?? ''
    const idxThinking = text.indexOf('MARKER_ALPHA_THINK')
    const idxTool = text.indexOf('MARKER_BETA_TOOL')
    const idxGamma = text.indexOf('MARKER_GAMMA_TEXT')
    const idxDelta = text.indexOf('MARKER_DELTA_TEXT')

    expect(idxThinking).toBeGreaterThanOrEqual(0)
    expect(idxTool).toBeGreaterThan(idxThinking)
    expect(idxGamma).toBeGreaterThan(idxTool)
    expect(idxDelta).toBeGreaterThan(idxGamma)
  })

  it('空 parts 且流式中时显示正在思考占位', () => {
    const { getByText } = render(
      <ChatMessage
        message={{
          id: 'msg-stream',
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          isStreaming: true,
          parts: [],
        }}
        formatTime={() => ''}
        onCopy={noop}
        onEdit={noop}
        onDelete={noop}
        onRegenerate={noop}
      />,
    )

    expect(getByText(/正在思考/)).toBeInTheDocument()
  })
})
