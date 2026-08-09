/**
 * dashboard_feed_write 工具落盘逻辑测试
 *
 * 资讯抓取改为 Agent 驱动后，Agent 抓完资讯必须调用这个工具才能让结构化结果
 * 出现在概览页资讯卡片上（纯文本回复不会）。这里验证 execute 覆盖逻辑：
 * 参数校验、item 兜底 id 生成、成功/失败路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const writeDashboardFeedSnapshotMock = vi.fn(async () => undefined)
vi.mock('../dashboard-feed-store', () => ({
  writeDashboardFeedSnapshot: writeDashboardFeedSnapshotMock,
  DEFAULT_DASHBOARD_FEED_ID: 'news',
}))

const { BridgeToolRegistrar } = await import('./bridge-tool-registrar')

function makeRegistrar() {
  const registered = new Map<string, { execute: (...args: unknown[]) => unknown }>()
  const toolRegistry = {
    register: (tool: { name: string; execute: (...args: unknown[]) => unknown }) => {
      registered.set(tool.name, tool)
    },
  }
  const deps = {
    toolRegistry,
    toolContext: {},
  } as unknown as ConstructorParameters<typeof BridgeToolRegistrar>[0]
  const registrar = new BridgeToolRegistrar(deps)
  ;(registrar as unknown as { registerDashboardFeedTool: () => void }).registerDashboardFeedTool()
  return registered.get('dashboard_feed_write')!
}

describe('dashboard_feed_write execute', () => {
  beforeEach(() => {
    writeDashboardFeedSnapshotMock.mockClear()
  })

  it('title 为空时返回错误，不写盘', async () => {
    const tool = makeRegistrar()
    const result = await tool.execute('call-1', { title: '', items: [{ title: 'a' }] })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(JSON.parse(text)).toMatchObject({ status: 'error' })
    expect(writeDashboardFeedSnapshotMock).not.toHaveBeenCalled()
  })

  it('items 为空数组时返回错误，不写盘', async () => {
    const tool = makeRegistrar()
    const result = await tool.execute('call-2', { title: '最近资讯', items: [] })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(JSON.parse(text)).toMatchObject({ status: 'error' })
    expect(writeDashboardFeedSnapshotMock).not.toHaveBeenCalled()
  })

  it('正常参数写入 snapshot，item 缺 href 时用 title-index 兜底 id', async () => {
    const tool = makeRegistrar()
    const result = await tool.execute('call-3', {
      title: '最近资讯',
      summary: '今天的趋势',
      items: [
        { title: 'A 条目', href: 'https://a.com', summary: '摘要A', source: '来源A' },
        { title: 'B 条目' },
      ],
    })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(JSON.parse(text)).toMatchObject({ status: 'ok', itemCount: 2 })

    expect(writeDashboardFeedSnapshotMock).toHaveBeenCalledTimes(1)
    const snapshot = writeDashboardFeedSnapshotMock.mock.calls[0][0] as {
      feedId: string
      title: string
      summary?: string
      items: Array<{ id: string; title: string; href?: string; source?: string }>
    }
    expect(snapshot.feedId).toBe('news')
    expect(snapshot.title).toBe('最近资讯')
    expect(snapshot.summary).toBe('今天的趋势')
    expect(snapshot.items[0]).toMatchObject({ id: 'https://a.com', title: 'A 条目', href: 'https://a.com', source: '来源A' })
    expect(snapshot.items[1].id).toBe('B 条目-1')
  })

  it('写盘抛异常时捕获并返回错误结果，不向外抛出', async () => {
    writeDashboardFeedSnapshotMock.mockRejectedValueOnce(new Error('磁盘满'))
    const tool = makeRegistrar()
    const result = await tool.execute('call-4', { title: '最近资讯', items: [{ title: 'a' }] })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(JSON.parse(text)).toMatchObject({ status: 'error', message: '磁盘满' })
  })
})
