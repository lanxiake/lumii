/**
 * BackgroundTaskCard 组件测试
 *
 * 覆盖长耗时工具后台化在对话流内的可见性：空列表不渲染、运行中/完成/失败三态文案与折叠展开。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { BackgroundTaskList } from '../../renderer/pages/ChatPage/components/BackgroundTaskCard'
import { formatTaskElapsed } from '../../renderer/pages/ChatPage/components/BackgroundTaskCard/format'
import type { BackgroundTask } from '../../renderer/hooks/business/useAgentRuntime/agent-runtime-store'

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: 'task-1',
    toolName: 'mcp__comfyui-remote__enqueue_workflow',
    label: 'ComfyUI: enqueue_workflow',
    status: 'running',
    startedAt: 1_000_000,
    ...overrides,
  }
}

describe('formatTaskElapsed', () => {
  it('秒级/分级格式化', () => {
    expect(formatTaskElapsed(0, 5_000, 5_000)).toBe('5s')
    expect(formatTaskElapsed(0, 65_000, 65_000)).toBe('1m5s')
    expect(formatTaskElapsed(0, 120_000, 120_000)).toBe('2m')
  })

  it('运行中（无 endedAt）以 now 计时', () => {
    expect(formatTaskElapsed(0, undefined, 30_000)).toBe('30s')
  })
})

describe('BackgroundTaskList', () => {
  it('空列表不渲染', () => {
    const { container } = render(<BackgroundTaskList tasks={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('运行中任务显示标签与「后台执行中」', () => {
    const { getByText } = render(<BackgroundTaskList tasks={[makeTask()]} />)
    expect(getByText('ComfyUI: enqueue_workflow')).toBeInTheDocument()
    expect(getByText('后台执行中')).toBeInTheDocument()
  })

  it('完成任务可展开看产出摘要', () => {
    const task = makeTask({ status: 'succeeded', endedAt: 1_010_000, summary: '产出 8 帧动作表' })
    const { getByText, queryByText } = render(<BackgroundTaskList tasks={[task]} />)
    expect(getByText('已完成')).toBeInTheDocument()
    expect(queryByText('产出 8 帧动作表')).toBeNull()
    fireEvent.click(getByText('ComfyUI: enqueue_workflow'))
    expect(getByText('产出 8 帧动作表')).toBeInTheDocument()
  })

  it('失败任务展开显示失败原因', () => {
    const task = makeTask({ status: 'failed', endedAt: 1_002_000, error: 'MCP request timeout' })
    const { getByText, queryByText } = render(<BackgroundTaskList tasks={[task]} />)
    expect(getByText('失败')).toBeInTheDocument()
    expect(queryByText('MCP request timeout')).toBeNull()
    fireEvent.click(getByText('ComfyUI: enqueue_workflow'))
    expect(getByText('MCP request timeout')).toBeInTheDocument()
  })

  it('多任务按序渲染', () => {
    const { getAllByRole } = render(
      <BackgroundTaskList
        tasks={[
          makeTask({ taskId: 'a', label: 'A' }),
          makeTask({ taskId: 'b', label: 'B', status: 'succeeded', endedAt: 2, summary: 'ok' }),
        ]}
      />,
    )
    expect(getAllByRole('listitem')).toHaveLength(2)
  })
})

describe('BackgroundTaskCard 中断', () => {
  const sendCommand = vi.fn(async () => undefined)
  beforeEach(() => {
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { agentRuntime: { sendCommand } }
    sendCommand.mockClear()
  })
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('运行中显示「中断」按钮，点击下发 background-task:cancel', () => {
    const { getByText } = render(<BackgroundTaskList tasks={[makeTask()]} />)
    fireEvent.click(getByText('中断'))
    expect(sendCommand).toHaveBeenCalledWith({ type: 'background-task:cancel', taskId: 'task-1' })
  })

  it('已完成的任务不显示中断按钮', () => {
    const { queryByText } = render(
      <BackgroundTaskList tasks={[makeTask({ status: 'succeeded', endedAt: 1_010_000, summary: 'ok' })]} />,
    )
    expect(queryByText('中断')).toBeNull()
  })

  it('已取消的任务显示「已取消」', () => {
    const { getByText } = render(
      <BackgroundTaskList tasks={[makeTask({ status: 'cancelled', endedAt: 1_005_000 })]} />,
    )
    expect(getByText('已取消')).toBeInTheDocument()
  })
})
