/**
 * RecentFocus（近期关注）分段测试。
 *
 * 重点守「资产体检」这一段的接入：
 * - 它是第 4 个分段，与前三个并列在同一个 tablist 里；
 * - 切到它时渲染体检内容，且**不发列表请求**（它有自己的数据源）；
 * - 页脚不渲染跳转入口（体检没有可跳的页面）。
 *
 * 前三个分段的数据源在这里全部打桩，测的是接线不是取数。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const listMemories = vi.fn()
const listSources = vi.fn()
const getSource = vi.fn()
const fetchMaintenanceOverview = vi.fn()
const sendCommand = vi.fn()

vi.mock('../../renderer/hooks/business/useMemoryUsage', () => ({
  useMemoryUsage: () => ({ listMemories }),
}))
vi.mock('../../renderer/hooks/business/useWikiPage', () => ({
  useWikiPage: () => ({ listSources, getSource }),
}))
vi.mock('../../renderer/services/maintenance-report-service', () => ({
  fetchMaintenanceOverview: (...args: unknown[]) => fetchMaintenanceOverview(...args),
}))

const { RecentFocus } = await import('../../renderer/pages/DashboardPage/components/RecentFocus')

describe('RecentFocus 资产体检分段', () => {
  beforeEach(() => {
    listMemories.mockReset().mockResolvedValue([])
    listSources.mockReset().mockResolvedValue([])
    getSource.mockReset()
    sendCommand.mockReset().mockResolvedValue({ jobs: [] })
    fetchMaintenanceOverview.mockReset().mockResolvedValue({
      reports: [
        {
          id: 'r1',
          agentId: 'system-keeper',
          scope: 'memory',
          summary: '工作记忆 228 条，发现 1 处重复',
          findings: [{ key: 'memory:duplicate', severity: 'high', title: '两条记忆内容重复' }],
          checked: [],
          trigger: 'manual',
          createdAt: new Date().toISOString(),
        },
      ],
      diff: null,
    })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      agentRuntime: { sendCommand },
    }
  })

  it('四个分段并列在同一个 tablist 里', () => {
    render(<RecentFocus />)
    const tabs = screen.getAllByRole('tab').map((el) => el.textContent)
    expect(tabs).toEqual(['工作记忆', '资料库', '定时任务', '资产体检'])
  })

  it('切到资产体检时渲染体检内容，且不发列表请求', async () => {
    render(<RecentFocus />)
    await waitFor(() => expect(listMemories).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('tab', { name: '资产体检' }))

    await waitFor(() => expect(screen.getByText('工作记忆 228 条，发现 1 处重复')).toBeInTheDocument())
    expect(screen.getByText('两条记忆内容重复')).toBeInTheDocument()
    // 分段自带数据源，不该为它去拉记忆/资料/定时任务列表
    expect(listMemories).toHaveBeenCalledTimes(1) // 只有首屏那一次
    expect(fetchMaintenanceOverview).toHaveBeenCalled()
  })

  it('资产体检分段没有跳转入口（不同于前三个分段）', async () => {
    render(<RecentFocus />)
    await waitFor(() => expect(screen.getByRole('button', { name: '管理记忆' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('tab', { name: '资产体检' }))

    await waitFor(() => expect(screen.getByText(/报告来自「灵栖维护」的巡检/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '管理记忆' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '任务中心' })).not.toBeInTheDocument()
  })

  it('切回工作记忆分段仍走原来的列表', async () => {
    listMemories.mockResolvedValue([
      { id: 'm1', category: 'project', content: '在做情报与维护深化', createdAt: Date.now(), importance: 0.8 },
    ])
    render(<RecentFocus />)
    await waitFor(() => expect(screen.getByText('在做情报与维护深化')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('tab', { name: '资产体检' }))
    await waitFor(() => expect(screen.getByText(/报告来自「灵栖维护」的巡检/)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('tab', { name: '工作记忆' }))
    await waitFor(() => expect(screen.getByText('在做情报与维护深化')).toBeInTheDocument())
  })
})
