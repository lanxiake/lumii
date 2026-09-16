/**
 * NewsFeed（概览页资讯卡）期刊渲染测试。
 *
 * 卡片是累积的，一次推送 = 一期。这里守住期刊化的三件承诺：
 * - 默认只展开最新一期，更早的按期折叠（否则又退化成一条流水）；
 * - 折叠的期仍要看得见「什么时候推的、推了几条、讲了什么」（综述在期头上）；
 * - 点期头能展开，点条目跳对话页预填解读请求。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const fetchFeedMeta = vi.fn()
const fetchFeedBatches = vi.fn()
const refreshDashboardFeed = vi.fn()

vi.mock('../../renderer/services/dashboard-feed-service', () => ({
  fetchFeedMeta: (...args: unknown[]) => fetchFeedMeta(...args),
  fetchFeedBatches: (...args: unknown[]) => fetchFeedBatches(...args),
  refreshDashboardFeed: (...args: unknown[]) => refreshDashboardFeed(...args),
}))

const { NewsFeed } = await import('../../renderer/pages/DashboardPage/components/NewsFeed')

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString()
}

const item = (id: string, title: string) => ({ id, title, source: '36氪', kind: 'news' })

function batch(over: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    feedId: 'news',
    source: 'agent',
    summary: '今天最集中的信号是 AI 圈的「限速」之争',
    createdAt: hoursAgo(1),
    items: [item('a', '今天的甲'), item('b', '今天的乙')],
    ...over,
  }
}

describe('NewsFeed 期刊渲染', () => {
  beforeEach(() => {
    fetchFeedMeta.mockReset().mockResolvedValue({ feedId: 'news', title: '最近资讯', updatedAt: Date.now() })
    fetchFeedBatches.mockReset()
    refreshDashboardFeed.mockReset()
  })

  it('默认只展开最新一期，更早的期折叠', async () => {
    fetchFeedBatches.mockResolvedValue({
      feedId: 'news',
      batches: [
        batch({ id: 'b2', items: [item('c', '最新一期的条目')] }),
        batch({ id: 'b1', createdAt: hoursAgo(5), items: [item('a', '上一期的条目')] }),
      ],
      nextCursor: null,
    })

    render(<NewsFeed />)

    await waitFor(() => expect(screen.getByText('最新一期的条目')).toBeInTheDocument())
    // 折叠期的条目不在 DOM 里
    expect(screen.queryByText('上一期的条目')).not.toBeInTheDocument()
    // 但期头仍然可见
    expect(screen.getByText('最新')).toBeInTheDocument()
  })

  it('折叠的期仍显示时间 / 来源 / 条数 / 综述', async () => {
    fetchFeedBatches.mockResolvedValue({
      feedId: 'news',
      batches: [
        batch({ id: 'b2', items: [item('c', '最新')], summary: '本期综述' }),
        batch({
          id: 'b1',
          createdAt: hoursAgo(5),
          items: [item('a', '甲'), item('b', '乙')],
          summary: '上一期的综述文字',
          source: 'cron',
        }),
      ],
      nextCursor: null,
    })

    render(<NewsFeed />)

    await waitFor(() => expect(screen.getByText('上一期的综述文字')).toBeInTheDocument())
    expect(screen.getByText('定时推送')).toBeInTheDocument() // 来源标签
    expect(screen.getByText('2 条')).toBeInTheDocument()
    // 两期各有自己的时间标签（今天 HH:MM 形式，相对时间看不出「今天推了几期」）
    expect(screen.getAllByText(/今天 \d{2}:\d{2}/)).toHaveLength(2)
  })

  it('点期头展开该期的条目', async () => {
    fetchFeedBatches.mockResolvedValue({
      feedId: 'news',
      batches: [
        batch({ id: 'b2', items: [item('c', '最新一期的条目')] }),
        batch({ id: 'b1', createdAt: hoursAgo(5), items: [item('a', '上一期的条目')] }),
      ],
      nextCursor: null,
    })

    render(<NewsFeed />)
    await waitFor(() => expect(screen.getByText('最新一期的条目')).toBeInTheDocument())
    expect(screen.queryByText('上一期的条目')).not.toBeInTheDocument()

    // 折叠期的期头按钮（aria-expanded=false）
    const headers = screen.getAllByRole('button', { expanded: false })
    fireEvent.click(headers[headers.length - 1])

    expect(screen.getByText('上一期的条目')).toBeInTheDocument()
  })

  it('头部给出期数与总条数，而不是只有一条流水', async () => {
    fetchFeedBatches.mockResolvedValue({
      feedId: 'news',
      batches: [
        batch({ id: 'b2', items: [item('c', '甲')] }),
        batch({ id: 'b1', createdAt: hoursAgo(5), items: [item('a', '乙'), item('b', '丙')] }),
      ],
      nextCursor: null,
    })

    render(<NewsFeed />)
    await waitFor(() => expect(screen.getByText(/2 期 · 3 条/)).toBeInTheDocument())
  })

  it('点条目跳对话页并预填解读请求', async () => {
    const onViewChange = vi.fn()
    const dispatched: unknown[] = []
    const listener = (e: Event) => dispatched.push((e as CustomEvent).detail)
    window.addEventListener('mtbot:chat-draft-request', listener)

    fetchFeedBatches.mockResolvedValue({ feedId: 'news', batches: [batch()], nextCursor: null })
    render(<NewsFeed onViewChange={onViewChange} />)
    await waitFor(() => expect(screen.getByText('今天的甲')).toBeInTheDocument())

    fireEvent.click(screen.getByText('今天的甲'))

    expect(onViewChange).toHaveBeenCalledWith('chat')
    const detail = dispatched[0] as { text: string }
    expect(detail.text).toContain('今天的甲')
    window.removeEventListener('mtbot:chat-draft-request', listener)
  })

  it('没有任何一期时给空态文案', async () => {
    fetchFeedBatches.mockResolvedValue({ feedId: 'news', batches: [], nextCursor: null })
    render(<NewsFeed />)
    await waitFor(() => expect(screen.getByText(/还没有数据/)).toBeInTheDocument())
    // 头部如实报 0，而不是假装抓过
    expect(screen.getByText(/0 期 · 0 条/)).toBeInTheDocument()
  })

  it('历史回填的期标为「历史」而不是假装是 Agent 推的', async () => {
    fetchFeedBatches.mockResolvedValue({
      feedId: 'news',
      batches: [batch({ id: 'legacy', source: 'legacy', summary: undefined })],
      nextCursor: null,
    })
    render(<NewsFeed />)
    await waitFor(() => expect(screen.getByText('历史')).toBeInTheDocument())
  })
})
