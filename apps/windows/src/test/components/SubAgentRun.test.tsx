/**
 * SubAgentRunBlock 组件测试
 *
 * 覆盖 docs/plans/专项Agent/08-委托可见性.md §4.4：子 Agent 运行块的身份 / 状态 / 折叠行为。
 */
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { SubAgentRunBlock } from '../../renderer/pages/ChatPage/components/SubAgentRun'
import type { SubAgentRun } from '../../renderer/pages/ChatPage/components/ChatContainer/sub-agent-runs'

function makeRun(overrides: Partial<SubAgentRun> = {}): SubAgentRun {
  return {
    instanceId: 'agent-1789346095555-cyffjt',
    label: '灵栖维护',
    isStreaming: false,
    parts: [],
    timestamp: new Date('2026-09-14T01:00:00Z'),
    ...overrides,
  }
}

const RUNNING = makeRun({
  isStreaming: true,
  parts: [
    { type: 'thinking', id: 'th-1', text: 'MARKER_CHILD_THINK', status: 'streaming' },
    { type: 'tool', id: 't-1', name: 'file_read', args: {}, status: 'running' },
  ],
})

const DONE = makeRun({
  parts: [
    { type: 'thinking', id: 'th-1', text: 'MARKER_CHILD_THINK', status: 'done' },
    { type: 'tool', id: 't-1', name: 'file_read', args: {}, status: 'done' },
    { type: 'tool', id: 't-2', name: 'file_write', args: {}, status: 'done' },
  ],
})

describe('SubAgentRunBlock', () => {
  it('头部给出「谁在干、干到哪」：专家名 + 状态 + 工具计数', () => {
    const { getByRole, container } = render(
      <SubAgentRunBlock run={DONE}><div>body</div></SubAgentRunBlock>,
    )

    const header = getByRole('button')
    expect(header.textContent).toContain('灵栖维护')
    expect(header.textContent).toContain('已完成')
    expect(header.textContent).toContain('2 个工具')
    expect(container.querySelector('[data-instance-id]')).toHaveAttribute(
      'data-instance-id',
      DONE.instanceId,
    )
  })

  it('流式中默认展开，完成后默认收起', () => {
    const running = render(<SubAgentRunBlock run={RUNNING}><div>MARKER_RUN_BODY</div></SubAgentRunBlock>)
    expect(running.container.textContent).toContain('MARKER_RUN_BODY')
    expect(running.container.querySelector('[data-streaming]')).toHaveAttribute('data-streaming', 'true')

    const done = render(<SubAgentRunBlock run={DONE}><div>MARKER_RUN_BODY</div></SubAgentRunBlock>)
    expect(done.container.textContent).not.toContain('MARKER_RUN_BODY')
  })

  it('点击头部可展开/收起（完成后也能查看轨迹）', () => {
    const { getByRole, container } = render(
      <SubAgentRunBlock run={DONE}><div>MARKER_RUN_BODY</div></SubAgentRunBlock>,
    )
    expect(container.textContent).not.toContain('MARKER_RUN_BODY')

    const header = getByRole('button')
    fireEvent.click(header)
    expect(container.textContent).toContain('MARKER_RUN_BODY')

    fireEvent.click(header)
    expect(container.textContent).not.toContain('MARKER_RUN_BODY')
  })
})
