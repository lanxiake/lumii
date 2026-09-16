/**
 * NewsFeed（概览页资讯卡）跨天分隔测试。
 *
 * 卡片是累积的：一次抓取推十几条，历史上越堆越多。没有日期分隔时新旧条目混成
 * 一条长列，用户看不出哪些是今天新推的。这里守住三件事：
 * - 相邻不同「天」之间插入分隔行，同一天只插一次；
 * - 卡片编号在「天」内从 01 重新起算（扫读时关心的是今天第几条）；
 * - 分隔行显示该天条数。
 *
 * 数据源被 mock 掉（组件只经 dashboard-feed-service 取数），不碰 IPC。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const fetchFeedMeta = vi.fn()
const fetchFeedPage = vi.fn()
const refreshDashboardFeed = vi.fn()

vi.mock('../../renderer/services/dashboard-feed-service', () => ({
  fetchFeedMeta: (...args: unknown[]) => fetchFeedMeta(...args),
  fetchFeedPage: (...args: unknown[]) => fetchFeedPage(...args),
  refreshDashboardFeed: (...args: unknown[]) => refreshDashboardFeed(...args),
}))

const { NewsFeed } = await import('../../renderer/pages/DashboardPage/components/NewsFeed')

/** 本地时间的当天零点偏移，避免用 UTC 构造把「今天」算错 */
function daysAgoAt(days: number, hour = 10): number {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

function item(id: string, title: string, timestamp: number) {
  return { id, title, timestamp, source: '36氪', kind: 'news' }
}

describe('NewsFeed 跨天分隔', () => {
  beforeEach(() => {
    fetchFeedMeta.mockReset().mockResolvedValue({ feedId: 'news', title: '最近资讯', updatedAt: Date.now() })
    fetchFeedPage.mockReset()
    refreshDashboardFeed.mockReset()
  })

  it('按天插入分隔行，同一天只插一次', async () => {
    fetchFeedPage.mockResolvedValue({
      feedId: 'news',
      items: [
        item('a', '今天的甲', daysAgoAt(0, 9)),
        item('b', '今天的乙', daysAgoAt(0, 8)),
        item('c', '昨天的丙', daysAgoAt(1)),
      ],
      nextCursor: null,
    })

    render(<NewsFeed />)

    await waitFor(() => expect(screen.getByText('今天的甲')).toBeInTheDocument())
    expect(screen.getAllByText('今天')).toHaveLength(1)
    expect(screen.getAllByText('昨天')).toHaveLength(1)
    // 今天的 2 条 + 昨天的 1 条
    expect(screen.getByText('2 条')).toBeInTheDocument()
    expect(screen.getByText('1 条')).toBeInTheDocument()
  })

  it('编号在「天」内从 01 重新起算，不跨天连续编号', async () => {
    fetchFeedPage.mockResolvedValue({
      feedId: 'news',
      items: [
        item('a', '今天的甲', daysAgoAt(0, 9)),
        item('b', '今天的乙', daysAgoAt(0, 8)),
        item('c', '昨天的丙', daysAgoAt(1)),
        item('d', '昨天的丁', daysAgoAt(1, 9)),
      ],
      nextCursor: null,
    })

    const { container } = render(<NewsFeed />)

    await waitFor(() => expect(screen.getByText('今天的甲')).toBeInTheDocument())
    // 索引列：今天 01/02，昨天重新 01/02（若跨天连续编号会是 03/04）
    const idx = [...container.querySelectorAll('[aria-hidden="true"]')]
      .map((el) => el.textContent?.trim())
      .filter((t) => t && /^\d{2}$/.test(t))
    expect(idx).toEqual(['01', '02', '01', '02'])
  })

  it('七天以前的条目写明具体日期，而不是「N 天前」', async () => {
    fetchFeedPage.mockResolvedValue({
      feedId: 'news',
      items: [item('a', '上周的稿子', daysAgoAt(9))],
      nextCursor: null,
    })

    render(<NewsFeed />)

    const nineDaysAgo = new Date(daysAgoAt(9))
    await waitFor(() =>
      expect(
        screen.getByText(`${nineDaysAgo.getMonth() + 1} 月 ${nineDaysAgo.getDate()} 日`),
      ).toBeInTheDocument(),
    )
  })
})
