/**
 * ChatMessage parts 时间线渲染测试
 * 验证 thinking / tool / text 按 parts 顺序交错出现在 DOM 中
 */

import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ChatMessage } from '../../renderer/pages/ChatPage/components/ChatMessage'
import {
  ChatMessageActionsProvider,
  type ChatMessageActions,
} from '../../renderer/pages/ChatPage/contexts/ChatMessageActionsContext'
import type { ChatMessage as ChatMessageType } from '../../renderer/hooks/business/useChat'
import type { AssistantPart } from '@mtbot/agent-runtime/browser'
import type { SubAgentRun } from '../../renderer/pages/ChatPage/components/ChatContainer/sub-agent-runs'

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
function buildPartsMessage(parts: AssistantPart[], isStreaming = false): ChatMessageType {
  return {
    id: 'msg-parts-1',
    role: 'assistant',
    content: parts
      .filter((p): p is Extract<AssistantPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n'),
    timestamp: new Date('2026-08-08T10:00:00'),
    isStreaming,
    parts,
  }
}

/**
 * 渲染一条 assistant 消息（可选挂载子 Agent 运行），两个 describe 共用
 *
 * @param isStreaming 本条消息是否仍在流式 —— 委托卡片判「执行中 / 已中断」的必要条件
 */
function renderMessage(
  parts: AssistantPart[],
  subAgentRuns?: SubAgentRun[],
  isStreaming = false,
) {
  return render(
    <ChatMessageActionsProvider value={messageActions}>
      <ChatMessage
        message={buildPartsMessage(parts, isStreaming)}
        subAgentRuns={subAgentRuns}
      />
    </ChatMessageActionsProvider>,
  )
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
    // 真实场景里「运行中」必然伴随消息仍在流式（判据见 08-委托可见性.md §5）
    const { container } = renderMessage(parts, undefined, true)
    const text = container.textContent ?? ''
    expect(text).toContain('执行中')
    expect(text).toContain('正在等待这位专家执行')
  })

  it('中断残留不再显示「执行中」：消息已结束 + part 停在 running → 已中断', () => {
    // 中断/重启后 tool part 永久停在 running（finalizeAssistantParts 只收尾 thinking/text），
    // 旧判据 `part.status === 'running' || result === undefined` 会让卡片永远显示执行中
    const parts: AssistantPart[] = [spawnPart({ status: 'running', result: undefined })]
    const { container } = renderMessage(parts, undefined, false)
    const text = container.textContent ?? ''

    expect(text).toContain('已中断')
    expect(text).not.toContain('执行中')
    expect(text).not.toContain('失败')
    expect(text).toContain('重新委托')
  })

  it('已收尾为 interrupted 的工具行显示「已中断」，不再报「正在」', () => {
    const parts: AssistantPart[] = [
      { type: 'text', id: 'tx-1', text: '先跑个命令', status: 'done' },
      { type: 'tool', id: 't-1', name: 'bash', args: { command: 'ls' }, status: 'interrupted' },
    ]
    const { container, getAllByRole } = renderMessage(parts)

    // 展开过程折叠区 → 展开工具批次组 → 看到单个工具行
    fireEvent.click(getAllByRole('button', { name: /执行过程/ })[0]!)
    fireEvent.click(getAllByRole('button', { name: /展开$/ })[0]!)

    const text = container.textContent ?? ''
    expect(text).toContain('已中断')
    expect(text).not.toContain('正在')
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

  it('失败结果是裸文本（非 JSON 载荷）时，卡片仍显示原始失败原因', () => {
    // 回归：spawn_agent 未注册时工具结果就是一句「Tool spawn_agent not found」，
    // parseSpawnResult 解析不出载荷 → 此前卡片只显示笼统的「委托执行失败」，原因丢失。
    const parts: AssistantPart[] = [
      spawnPart({
        status: 'error',
        isError: true,
        result: {
          content: [{ type: 'text', text: 'Tool spawn_agent not found' }],
        },
      }),
    ]
    const { getByRole, container } = renderMessage(parts)
    const text = container.textContent ?? ''
    expect(text).toContain('失败')
    expect(text).toContain('Tool spawn_agent not found')
    expect(text).not.toContain('委托执行失败')

    fireEvent.click(getByRole('button', { name: /团队委托/ }))
    expect(container.textContent ?? '').toContain('失败原因')
  })

  it('详情展开后显示完整任务与完整产出', () => {
    const { getByRole, container } = renderMessage([spawnPart()])
    expect(container.textContent ?? '').not.toContain('MARKER_SPAWN_PROMPT')

    fireEvent.click(getByRole('button', { name: /团队委托/ }))

    const text = container.textContent ?? ''
    expect(text).toContain('MARKER_SPAWN_PROMPT')
    expect(text).toContain('MARKER_SPAWN_OUTPUT')
  })

  // --- 专家名解析（见 docs/plans/专项Agent/08-委托可见性.md §3） ---

  it('agentType=default 显示「系统默认」，不回退模型自填的编码名', () => {
    // 实测数据：模型传 agentType="default" + name="24shi-b12-fix"，
    // 旧实现查表落空后会把这串编码直接当专家名显示
    const parts: AssistantPart[] = [
      spawnPart({
        args: {
          name: '24shi-b12-fix',
          agentType: 'default',
          mode: 'async',
          description: '写作并构建第 12 讲 HTML',
          prompt: 'MARKER_SPAWN_PROMPT',
        },
      }),
    ]
    const text = renderMessage(parts).container.textContent ?? ''

    expect(text).toContain('系统默认')
    expect(text).not.toContain('24shi-b12-fix')
  })

  it('builtin:* 子 Agent 显示中文名而非 id 字面量', () => {
    const parts: AssistantPart[] = [
      spawnPart({ args: { name: '探索代码', agentType: 'builtin:explore', mode: 'sync', prompt: 'p' } }),
    ]
    const text = renderMessage(parts).container.textContent ?? ''

    expect(text).toContain('Explore (代码探索)')
    expect(text).not.toContain('builtin:explore')
  })

  it('工具结果回传的权威名优先（用户自建 Agent 不在内置表里也能显示真名）', () => {
    const parts: AssistantPart[] = [
      spawnPart({
        args: { name: 'user-1757000000000-abc123', agentType: 'user-1757000000000-abc123', mode: 'sync', prompt: 'p' },
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                instanceId: 'inst-child-9',
                mode: 'sync',
                agentDefinitionId: 'user-1757000000000-abc123',
                agentName: '竞品调研助手',
                output: '产出',
              }),
            },
          ],
        },
      }),
    ]
    const text = renderMessage(parts).container.textContent ?? ''

    expect(text).toContain('竞品调研助手')
    expect(text).not.toContain('user-1757000000000-abc123')
  })

  it('历史消息（结果无 agentName）仍按内置表解析，不再显示 id', () => {
    const parts: AssistantPart[] = [
      spawnPart({ args: { name: '24shi-b11', agentType: 'default', mode: 'sync', prompt: 'p' } }),
    ]
    const text = renderMessage(parts).container.textContent ?? ''

    expect(text).toContain('系统默认')
    expect(text).not.toContain('24shi-b11')
  })
})

/**
 * 子 Agent 执行过程归属（docs/plans/专项Agent/08-委托可见性.md §4）
 *
 * 回归背景：子消息的 parts 曾被纯拼接进父气泡 —— 父的「执行过程」被子的工具污染，
 * 且父 isStreaming=true 会让每个思考块都变 live（用户看到「两个思考中都在跑」）。
 * 现在子轨迹按 instanceId 归组，只出现在对应委托卡片下方。
 */
describe('ChatMessage 子 Agent 执行过程归属', () => {
  /** 委托卡片：结果带 instanceId（与主进程一致），用于把子运行挂到卡片下 */
  function spawnCardPart(instanceId: string): Extract<AssistantPart, { type: 'tool' }> {
    return {
      type: 'tool',
      id: 't-spawn',
      name: 'spawn_agent',
      args: { name: '维护官', agentType: 'system-keeper', mode: 'sync', prompt: 'MARKER_SPAWN_PROMPT' },
      status: 'done',
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ status: 'ok', instanceId, mode: 'sync', output: 'MARKER_SPAWN_OUTPUT' }),
          },
        ],
      },
    }
  }

  const childThinking: AssistantPart = {
    type: 'thinking',
    id: 'child-th-1',
    text: 'MARKER_CHILD_THINK',
    status: 'done',
  }
  const childTool: AssistantPart = { type: 'tool', id: 'child-t-1', name: 'file_write', args: {}, status: 'done' }

  function makeRun(overrides: Partial<SubAgentRun> = {}): SubAgentRun {
    return {
      instanceId: 'inst-child-1',
      label: '灵栖维护',
      isStreaming: false,
      parts: [childThinking, childTool],
      timestamp: new Date('2026-08-08T10:00:01'),
      ...overrides,
    }
  }

  /**
   * 渲染一条含委托卡片的父消息。
   * @param cardInstanceId 卡片结果里声明的子实例 id（默认 inst-child-1，用于认领测试）
   */
  function renderParentWithRuns(runs: SubAgentRun[], cardInstanceId = 'inst-child-1') {
    const parts: AssistantPart[] = [
      { type: 'thinking', id: 'p-th-1', text: 'MARKER_PARENT_THINK', status: 'done' },
      { type: 'tool', id: 'p-t-1', name: 'file_read', args: {}, status: 'done' },
      spawnCardPart(cardInstanceId),
      { type: 'text', id: 'p-tx-1', text: 'MARKER_PARENT_FINAL', status: 'done' },
    ]
    return renderMessage(parts, runs)
  }

  it('父气泡的「执行过程」不含子 Agent 的工具（核心回归）', () => {
    const { container, getAllByRole } = renderParentWithRuns([makeRun()])

    // DOM 顺序上父的过程折叠先于卡片；子运行默认收起，不参与计数
    const parentFold = getAllByRole('button', { name: /执行过程/ })[0]!
    expect(parentFold.textContent).toContain('读取 1 个文件')
    expect(parentFold.textContent).not.toContain('编辑')

    // 子的轨迹没丢：挂在委托卡片下
    const runBlocks = container.querySelectorAll('[data-testid="sub-agent-run"]')
    expect(runBlocks).toHaveLength(1)
    expect(runBlocks[0]!.textContent).toContain('灵栖维护')
  })

  it('展开卡片下的子运行块 → 看到该专家自己的执行过程', () => {
    const { container } = renderParentWithRuns([makeRun()])

    // 收起态：只露身份与计数，过程正文不渲染
    const runBlock = container.querySelector('[data-testid="sub-agent-run"]') as HTMLElement
    expect(runBlock.textContent).toContain('灵栖维护')
    expect(runBlock.textContent).not.toContain('编辑')

    // 点运行块自己的头部（不是委托卡片头部）
    fireEvent.click(within(runBlock).getByRole('button'))

    // 子运行内部有自己的「执行过程」，属于这位专家（子的工具不在父的摘要里）
    const childFold = within(runBlock).getAllByRole('button', { name: /执行过程/ })[0]!
    expect(childFold.textContent).toContain('编辑 1 个文件')
  })

  it('流式中的子运行默认展开（正文直接可见）', () => {
    const { container, getAllByRole } = renderParentWithRuns([makeRun({ isStreaming: true })])

    const runBlock = container.querySelector('[data-testid="sub-agent-run"]')!
    expect(runBlock).toHaveAttribute('data-streaming', 'true')
    expect(runBlock.textContent).toContain('执行中')
    // 默认展开 → 子的执行过程正文已在 DOM 中
    expect(within(runBlock as HTMLElement).getAllByRole('button', { name: /执行过程/ })[0]!.textContent)
      .toContain('编辑 1 个文件')

    const parentFold = getAllByRole('button', { name: /执行过程/ })[0]!
    expect(parentFold.textContent).toContain('读取 1 个文件')
    expect(parentFold.textContent).not.toContain('编辑')
  })

  it('认领不到卡片的子运行作为独立块渲染，内容不丢', () => {
    const { container } = renderParentWithRuns(
      [makeRun({ instanceId: 'inst-orphan', label: '灵栖情报' })],
      'inst-child-unrelated',
    )

    // 卡片声明的是 inst-child-unrelated，这条 inst-orphan 无人认领
    const runBlocks = container.querySelectorAll('[data-testid="sub-agent-run"]')
    expect(runBlocks).toHaveLength(1)
    expect(runBlocks[0]).toHaveAttribute('data-instance-id', 'inst-orphan')
    expect(runBlocks[0]!.textContent).toContain('灵栖情报')
  })

  it('多个实例各自成块，不互相吞并', () => {
    const runs = [
      makeRun({ instanceId: 'inst-child-1', label: '灵栖维护' }),
      makeRun({ instanceId: 'inst-child-2', label: '灵栖情报' }),
    ]
    const { container } = renderParentWithRuns(runs)

    const ids = [...container.querySelectorAll('[data-testid="sub-agent-run"]')].map((el) =>
      el.getAttribute('data-instance-id'),
    )
    expect(ids).toEqual(['inst-child-1', 'inst-child-2'])
  })
})
