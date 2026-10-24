import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { BackgroundTask } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import { BackgroundTaskCard } from './index'

const now = Date.now()

const task: BackgroundTask = {
  taskId: 't1',
  toolName: 'mcp__comfyui__enqueue_workflow',
  label: '生成视频',
  status: 'running',
  startedAt: now - 30_000,
  progress: 70,
  currentStep: '渲染',
  milestones: [{ step: '渲染', status: 'in-progress', startTime: now - 12_000 }],
  logs: [{ level: 'info', message: '渲染中', timestamp: now - 5_000 }],
  outputs: [{ name: 'a.png', path: 'a.png', kind: 'image', url: 'https://example.test/a.png' }],
}

describe('BackgroundTaskCard 进度集成', () => {
  it('运行中默认展开里程碑，进度区可点收起，折叠态缩略图仍可预览', () => {
    render(<BackgroundTaskCard task={task} />)
    expect(screen.getByText('进行中 (70%)')).toBeTruthy()
    expect(screen.getAllByText('渲染').length).toBeGreaterThan(0)
    expect(screen.getByText(/里程碑/)).toBeTruthy()
    expect(screen.getByText('正常')).toBeTruthy()
    expect(screen.getByText(/本步/)).toBeTruthy()

    // 进度区点击收起详情
    fireEvent.click(screen.getByRole('button', { name: '展开或收起任务详情' }))
    expect(screen.queryByText(/里程碑/)).toBeNull()

    // 折叠态仍有可点缩略图
    expect(screen.getByRole('button', { name: '预览图片 a.png' })).toBeTruthy()
  })

  it('有 warn 日志时头上显示有警告，日志默认展开', () => {
    const warnTask: BackgroundTask = {
      ...task,
      logs: [
        { level: 'info', message: '渲染中', timestamp: now - 5_000 },
        { level: 'warn', message: '显存紧张', timestamp: now - 2_000 },
      ],
    }
    render(<BackgroundTaskCard task={warnTask} />)
    expect(screen.getByText('有警告')).toBeTruthy()
    expect(screen.getByText('显存紧张')).toBeTruthy()
  })

  it('可暂停任务显示「暂停」，暂停后显示「恢复」且计时冻结', () => {
    const pausedAt = now - 10_000
    const paused: BackgroundTask = {
      ...task,
      status: 'paused',
      pausable: true,
      pausedAt,
    }
    render(<BackgroundTaskCard task={paused} />)
    expect(screen.getByText('已暂停')).toBeTruthy()
    expect(screen.getByText('恢复')).toBeTruthy()
    expect(screen.queryByText('中断')).toBeNull()
    expect(screen.getByText(/计时已停/)).toBeTruthy()
  })

  it('不可暂停的任务不显示暂停按钮', () => {
    render(<BackgroundTaskCard task={{ ...task, pausable: false }} />)
    expect(screen.queryByText('暂停')).toBeNull()
    expect(screen.getByText('中断')).toBeTruthy()
  })

  it('运行中卸载后不再有计时器在跑（反复挂载不堆积）', () => {
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 20; i++) {
        const { unmount } = render(<BackgroundTaskCard task={task} />)
        unmount()
      }
      // 卸载后遗留的 interval 会让定时器数量持续增长；清空后应为 0
      expect(vi.getTimerCount()).toBe(0)

      const { unmount } = render(<BackgroundTaskCard task={task} />)
      expect(vi.getTimerCount()).toBe(1)
      unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('暂停/恢复命令', () => {
    const sendCommand = vi.fn(async () => undefined)
    afterEach(() => {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI
      sendCommand.mockClear()
    })

    it('点暂停下发 background-task:pause（paused=true）', () => {
      ;(window as unknown as { electronAPI?: unknown }).electronAPI = { agentRuntime: { sendCommand } }
      render(<BackgroundTaskCard task={{ ...task, pausable: true }} />)
      fireEvent.click(screen.getByText('暂停'))
      expect(sendCommand).toHaveBeenCalledWith({
        type: 'background-task:pause',
        taskId: 't1',
        paused: true,
      })
    })

    it('点恢复下发 paused=false', () => {
      ;(window as unknown as { electronAPI?: unknown }).electronAPI = { agentRuntime: { sendCommand } }
      render(<BackgroundTaskCard task={{ ...task, status: 'paused', pausable: true, pausedAt: now }} />)
      fireEvent.click(screen.getByText('恢复'))
      expect(sendCommand).toHaveBeenCalledWith({
        type: 'background-task:pause',
        taskId: 't1',
        paused: false,
      })
    })
  })
})
