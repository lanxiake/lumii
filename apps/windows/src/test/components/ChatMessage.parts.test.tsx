/**
 * ChatMessage parts 时间线渲染测试
 * 验证 thinking / tool / text 按 parts 顺序交错出现在 DOM 中
 */

import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
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

describe('ChatMessage 团队委托卡片（spawn_agent）', () => {
  /** 构造一条 spawn_agent 工具 part（jsonToolResult 包装与主进程一致） */
  function spawnPart(overrides: Partial<Extract<AssistantPart, { type: 'tool' }>> = {}): Extract<AssistantPart, { type: 'tool' }> {
    return {
      type: 'tool',
      id: 't-spawn',
      name: 'spawn_agent',
      args: {
        name: '竞品调研员',
        agentType: 'info-curator',
        mode: 'sync',
        description: '调研竞品最近的版本更新',
        prompt: 'MARKER_SPAWN_PROMPT 完整任务描述',
      },
      status: 'done',
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'ok',
              instanceId: 'inst-child-1',
              mode: 'sync',
              output: 'MARKER_SPAWN_OUTPUT 三条结论',
            }),
          },
        ],
      },
      ...overrides,
    }
  }

  function renderMessage(parts: AssistantPart[]) {
    return render(
      <ChatMessageActionsProvider value={messageActions}>
        <ChatMessage message={buildPartsMessage(parts)} />
      </ChatMessageActionsProvider>,
    )
  }

  it('委托卡片露在折叠区外：专家名 / 任务 / 产出摘要可见，不被工具批次吞掉', () => {
    const parts: AssistantPart[] = [
      { type: 'thinking', id: 'th-1', text: 'MARKER_SPAWN_THINK', status: 'done' },
      { type: 'tool', id: 'tool-1', name: 'file_read', args: {}, status: 'done' },
      spawnPart(),
      { type: 'thinking', id: 'th-2', text: 'MARKER_SPAWN_THINK_2', status: 'done' },
      { type: 'text', id: 'tx-1', text: 'MARKER_SPAWN_FINAL', status: 'done' },
    ]

    const { container } = renderMessage(parts)
    const text = container.textContent ?? ''

    // 折叠区仍收起（思考原文不进 DOM），委托卡片必须在折叠区外
    expect(text).not.toContain('MARKER_SPAWN_THINK')
    expect(text).toContain('团队委托')
    expect(text).toContain('灵栖情报')
    expect(text).toContain('调研竞品最近的版本更新')
    expect(text).toContain('已完成')
    // 产出摘要内联可见，不用展开
    expect(text).toContain('三条结论')
  })

  it('运行中的委托显示执行中提示', () => {
    const parts: AssistantPart[] = [
      spawnPart({ status: 'running', result: undefined }),
    ]
    const { container } = renderMessage(parts)
    const text = container.textContent ?? ''
    expect(text).toContain('执行中')
    expect(text).toContain('正在等待这位专家执行')
  })

  it('后台委托完成后提示会自动汇报', () => {
    const parts: AssistantPart[] = [
      spawnPart({
        args: {
          name: '调研员',
          agentType: 'info-curator',
          mode: 'async',
          description: '后台整理情报',
          prompt: '整理情报',
        },
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'ok', instanceId: 'inst-2', mode: 'async', message: 'task dispatched' }),
            },
          ],
        },
      }),
    ]
    const { container } = renderMessage(parts)
    const text = container.textContent ?? ''
    expect(text).toContain('已派发')
    expect(text).toContain('后台')
    expect(text).toContain('完成后会自动汇报')
  })

  it('委托失败显示失败原因', () => {
    const parts: AssistantPart[] = [
      spawnPart({
        status: 'done',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'error', message: 'MARKER_SPAWN_FAIL 并发上限已满' }),
            },
          ],
        },
      }),
    ]
    const { container } = renderMessage(parts)
    const text = container.textContent ?? ''
    expect(text).toContain('失败')
    expect(text).toContain('并发上限已满')
  })

  it('详情展开后显示完整任务与完整产出', () => {
    const { getByRole, container } = renderMessage([spawnPart()])
    expect(container.textContent ?? '').not.toContain('MARKER_SPAWN_PROMPT')

    fireEvent.click(getByRole('button', { name: /团队委托/ }))

    const text = container.textContent ?? ''
    expect(text).toContain('MARKER_SPAWN_PROMPT')
    expect(text).toContain('MARKER_SPAWN_OUTPUT')
  })
})
