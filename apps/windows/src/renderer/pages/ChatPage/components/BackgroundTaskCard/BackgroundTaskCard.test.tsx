import React from 'react'
import { describe, expect, it } from 'vitest'
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
})
