import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ActiveAgent } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import { AgentDashboard } from './index'

const agent = (over: Partial<ActiveAgent> & { instanceId: string }): ActiveAgent => ({
  name: '子 Agent',
  state: 'running',
  isSubAgent: true,
  startedAt: Date.now() - 5_000,
  ...over,
})

describe('AgentDashboard 并行看板', () => {
  it('少于 2 个子 Agent 时不渲染（单子 Agent 交给委托卡片）', () => {
    const { container } = render(
      <AgentDashboard agents={[agent({ instanceId: 'a1', name: '审查 A' })]} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('只统计子 Agent，主 Agent 不进看板', () => {
    render(
      <AgentDashboard
        agents={[
          agent({ instanceId: 'main', name: '主助手', isSubAgent: false }),
          agent({ instanceId: 'a1', name: '审查 A' }),
          agent({ instanceId: 'a2', name: '审查 B' }),
        ]}
      />,
    )
    expect(screen.getByText('2 个 · 2 个进行中')).toBeTruthy()
    expect(screen.queryByText('主助手')).toBeNull()
    expect(screen.getByText('审查 A')).toBeTruthy()
    expect(screen.getByText('审查 B')).toBeTruthy()
  })

  it('running 卡片有取消按钮，点击回传 instanceId；非 running 没有', () => {
    const onCancel = vi.fn()
    render(
      <AgentDashboard
        agents={[
          agent({ instanceId: 'a1', name: '在跑' }),
          agent({ instanceId: 'a2', name: '已完成', state: 'idle', status: 'succeeded' }),
        ]}
        onCancel={onCancel}
      />,
    )
    const buttons = screen.getAllByRole('button', { name: '取消' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    expect(onCancel).toHaveBeenCalledWith('a1')
  })

  it('失败与已完成分别用独立状态文案', () => {
    render(
      <AgentDashboard
        agents={[
          agent({ instanceId: 'a1', name: '挂掉的', state: 'error' }),
          agent({ instanceId: 'a2', name: '跑完的', state: 'idle', status: 'succeeded' }),
        ]}
      />,
    )
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getByText('2 个 · 均已结束')).toBeTruthy()
  })

  it('running 且长时间无进展时标「疑似卡住」，有进展则不标', () => {
    const now = Date.now()
    render(
      <AgentDashboard
        agents={[
          agent({ instanceId: 'stuck', name: '卡住的', lastProgressAt: now - 120_000 }),
          agent({ instanceId: 'alive', name: '在动的', lastProgressAt: now - 3_000 }),
        ]}
      />,
    )
    const stuckCard = screen.getByText('卡住的').closest('li')!
    const aliveCard = screen.getByText('在动的').closest('li')!
    expect(stuckCard.textContent).toContain('疑似卡住')
    expect(aliveCard.textContent).not.toContain('疑似卡住')
  })

  it('从 3 个收敛到 1 个时面板不闪没（最后那个还能取消）', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <AgentDashboard
        onCancel={onCancel}
        agents={[
          agent({ instanceId: 'a1', name: '剩下的' }),
          agent({ instanceId: 'a2', name: '跑完的', state: 'idle', status: 'succeeded' }),
        ]}
      />,
    )
    expect(screen.getByText('剩下的')).toBeTruthy()

    rerender(
      <AgentDashboard onCancel={onCancel} agents={[agent({ instanceId: 'a1', name: '剩下的' })]} />,
    )
    expect(screen.getByText('剩下的')).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()

    // 全部退场才消失
    rerender(<AgentDashboard onCancel={onCancel} agents={[]} />)
    expect(screen.queryByText('剩下的')).toBeNull()
  })

  it('「详情」按钮滚动到该子运行的轨迹（按 data-instance-id 定位）', () => {
    const target = document.createElement('div')
    target.setAttribute('data-instance-id', 'a1')
    target.scrollIntoView = vi.fn()
    document.body.appendChild(target)

    render(
      <AgentDashboard
        agents={[
          agent({ instanceId: 'a1', name: '甲' }),
          agent({ instanceId: 'a2', name: '乙' }),
        ]}
      />,
    )
    const details = screen.getAllByRole('button', { name: '详情' })
    fireEvent.click(details[0]!)
    expect(target.scrollIntoView).toHaveBeenCalled()
    target.remove()
  })
})
