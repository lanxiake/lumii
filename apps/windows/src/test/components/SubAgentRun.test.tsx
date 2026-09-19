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

/** 失败收场：错误原因由 groupSubAgentRuns 从子消息的 llmError/error 派生 */
const FAILED = makeRun({
  error: '模型服务账户余额不足，请充值后重试',
  parts: [{ type: 'tool', id: 't-1', name: 'file_read', args: {}, status: 'done' }],
})

const INTERRUPTED = makeRun({
  interrupted: true,
  parts: [{ type: 'tool', id: 't-1', name: 'bash', args: {}, status: 'interrupted' }],
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

  it('展开体末尾提供底部收起按钮：长轨迹读到底即可收起，不必滑回顶部', () => {
    const { getByRole, container } = render(
      <SubAgentRunBlock run={RUNNING}><div>MARKER_RUN_BODY</div></SubAgentRunBlock>,
    )
    // 流式默认展开，正文可见
    expect(container.textContent).toContain('MARKER_RUN_BODY')

    // 可见名精确为「收起」的是底部按钮（头部按钮名含专家名/状态/工具计数，不会精确相等）
    fireEvent.click(getByRole('button', { name: '收起' }))
    expect(container.textContent).not.toContain('MARKER_RUN_BODY')
  })

  it('失败态：头部显示「失败」并常驻原因，不再假装「已完成」', () => {
    const { getByRole, container } = render(
      <SubAgentRunBlock run={FAILED}><div>MARKER_RUN_BODY</div></SubAgentRunBlock>,
    )

    const header = getByRole('button')
    expect(header.textContent).toContain('失败')
    expect(header.textContent).not.toContain('已完成')
    // 原因不必展开就能看到（子运行死掉时必须能立刻知道为什么）
    expect(container.textContent).toContain('账户余额不足')
    expect(container.querySelector('[data-status]')).toHaveAttribute('data-status', 'failed')
  })

  it('失败原因过长时头部截断，展开后给全文', () => {
    const longError = `${'x'.repeat(200)}MARKER_FAIL_TAIL`
    const { getByRole, container } = render(
      <SubAgentRunBlock run={makeRun({ error: longError })}><div>body</div></SubAgentRunBlock>,
    )

    expect(container.textContent).toContain('x'.repeat(50))
    expect(container.textContent).not.toContain('MARKER_FAIL_TAIL')

    fireEvent.click(getByRole('button'))
    expect(container.textContent).toContain('MARKER_FAIL_TAIL')
  })

  it('中断态：显示「已中断」且不报失败（中止不是失败）', () => {
    const { getByRole, container } = render(
      <SubAgentRunBlock run={INTERRUPTED}><div>body</div></SubAgentRunBlock>,
    )

    const header = getByRole('button')
    expect(header.textContent).toContain('已中断')
    expect(header.textContent).not.toContain('失败')
    expect(container.querySelector('[data-status]')).toHaveAttribute('data-status', 'interrupted')
  })
})
