/**
 * ChatMessage parts 时间线渲染测试
 * 验证 thinking / tool / text 按 parts 顺序交错出现在 DOM 中
 */

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ChatMessage } from '../../renderer/pages/ChatPage/components/ChatMessage'
import type { ChatMessage as ChatMessageType } from '../../renderer/hooks/business/useChat'
import type { AssistantPart } from '@mtbot/agent-runtime/browser'

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
  it('按 thinking、工具批次、两段 text 的 parts 顺序交错渲染 DOM', () => {
    // 工具已折叠为批次分组：默认折叠，摘要行显示「调用 N 次工具」，
    // 单个工具名不再直接暴露，验证以批次摘要在时间线中的位置为准。
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
    const idxToolBatch = text.indexOf('调用 1 次工具')
    const idxGamma = text.indexOf('MARKER_GAMMA_TEXT')
    const idxDelta = text.indexOf('MARKER_DELTA_TEXT')

    expect(idxThinking).toBeGreaterThanOrEqual(0)
    expect(idxToolBatch).toBeGreaterThan(idxThinking)
    expect(idxGamma).toBeGreaterThan(idxToolBatch)
    expect(idxDelta).toBeGreaterThan(idxGamma)
  })

  it('多个连续工具折叠为一个批次分组，默认不展开工具名', () => {
    const parts: AssistantPart[] = [
      { type: 'tool', id: 't1', name: 'file_read', args: {}, status: 'done' },
      { type: 'tool', id: 't2', name: 'file_read', args: {}, status: 'done' },
      { type: 'tool', id: 't3', name: 'grep', args: {}, status: 'done' },
    ]

    const { getByText } = render(
      <ChatMessage
        message={buildPartsMessage(parts)}
        formatTime={() => '10:00'}
        onCopy={noop}
        onEdit={noop}
        onDelete={noop}
        onRegenerate={noop}
      />,
    )

    // 摘要按家族计数：读取 2 个文件 · 搜索 1 次
    expect(getByText('读取 2 个文件 · 搜索 1 次')).toBeInTheDocument()
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
