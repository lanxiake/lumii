import React from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { BackgroundTask } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import { BackgroundTaskCard } from './index'

const task: BackgroundTask = {
  taskId: 't1',
  toolName: 'mcp__comfyui__enqueue_workflow',
  label: '生成视频',
  status: 'running',
  startedAt: 1_000,
  progress: 70,
  currentStep: '渲染',
  milestones: [{ step: '渲染', status: 'in-progress' }],
  logs: [{ level: 'info', message: '渲染中', timestamp: 2_000 }],
  outputs: [{ name: 'a.png', path: 'a.png', kind: 'image', url: 'https://example.test/a.png' }],
}

describe('BackgroundTaskCard 进度集成', () => {
  it('运行中直接显示进度，展开后能看到里程碑、日志和预览', () => {
    render(<BackgroundTaskCard task={task} />)
    expect(screen.getByText('进行中 (70%)')).toBeTruthy()
    expect(screen.getByText('渲染')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /生成视频/ }))
    expect(screen.getByText(/里程碑/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /日志/ }))
    expect(screen.getByText('渲染中')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'a.png' })).toBeTruthy()
  })
})
