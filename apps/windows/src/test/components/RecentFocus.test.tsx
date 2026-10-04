/**
 * RecentFocus（近期关注）分段测试。
 *
 * 守的是「分段切换」这条接线：三个分段并列在同一个 tablist 里，各自走自己的数据源，
 * 页脚入口随分段切换。取数逻辑本身不在这里测，数据源全部打桩。
 *
 * （原先这一段还覆盖第 4 个分段「资产体检」，该分段已按需求整段移除。）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const listMemories = vi.fn()
const listSources = vi.fn()
const getSource = vi.fn()
const sendCommand = vi.fn()

vi.mock('../../renderer/hooks/business/useMemoryUsage', () => ({
  useMemoryUsage: () => ({ listMemories }),
}))
vi.mock('../../renderer/hooks/business/useWikiPage', () => ({
  useWikiPage: () => ({ listSources, getSource }),
}))

const { RecentFocus } = await import('../../renderer/pages/DashboardPage/components/RecentFocus')

describe('RecentFocus 分段切换', () => {
  beforeEach(() => {
    listMemories.mockReset().mockResolvedValue([])
    listSources.mockReset().mockResolvedValue([])
    getSource.mockReset()
    sendCommand.mockReset().mockImplementation((cmd: { type: string }) => {
      if (cmd.type === 'cron:list') {
        return Promise.resolve({ jobs: [{ id: 'j1', name: '早间简报' }] })
      }
      if (cmd.type === 'cron:runs') {
        return Promise.resolve({
          entries: [
            {
              id: 'r1',
              status: 'success',
              startedAt: Date.now(),
              durationMs: 1200,
              summary: '已生成简报',
            },
          ],
        })
      }
      return Promise.resolve({})
    })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      agentRuntime: { sendCommand },
    }
  })

  it('三个分段并列在同一个 tablist 里', () => {
    render(<RecentFocus />)
    const tabs = screen.getAllByRole('tab').map((el) => el.textContent)
    expect(tabs).toEqual(['工作记忆', '资料库', '定时任务'])
  })

  it('默认走工作记忆分段，页脚给出「管理记忆」入口', async () => {
    listMemories.mockResolvedValue([
      {
        id: 'm1',
        category: 'project',
        content: '在做情报与维护深化',
        createdAt: Date.now(),
        importance: 0.8,
      },
    ])
    render(<RecentFocus />)

    await waitFor(() => expect(screen.getByText('在做情报与维护深化')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '管理记忆' })).toBeInTheDocument()
  })

  it('切到定时任务走 cron:list / cron:runs，页脚入口随之变成「任务中心」', async () => {
    render(<RecentFocus />)
    await waitFor(() => expect(listMemories).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('tab', { name: '定时任务' }))

    await waitFor(() => expect(screen.getByText('早间简报 · 成功')).toBeInTheDocument())
    expect(sendCommand).toHaveBeenCalledWith({ type: 'cron:list', includeDisabled: true })
    expect(screen.getByRole('button', { name: '任务中心' })).toBeInTheDocument()
    // 定时任务分段有自己的数据源，不该再回头拉记忆列表
    expect(listMemories).toHaveBeenCalledTimes(1)
  })

  it('切走再切回工作记忆，仍走原来的列表', async () => {
    listMemories.mockResolvedValue([
      {
        id: 'm1',
        category: 'project',
        content: '在做情报与维护深化',
        createdAt: Date.now(),
        importance: 0.8,
      },
    ])
    render(<RecentFocus />)
    await waitFor(() => expect(screen.getByText('在做情报与维护深化')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('tab', { name: '资料库' }))
    fireEvent.click(screen.getByRole('tab', { name: '工作记忆' }))

    await waitFor(() => expect(screen.getByText('在做情报与维护深化')).toBeInTheDocument())
  })
})
