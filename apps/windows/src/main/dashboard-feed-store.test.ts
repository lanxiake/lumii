import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDashboardFeedSnapshot, __testables } from './dashboard-feed-store'

describe('dashboard-feed-store', () => {
  it('兼容旧新闻快照字段并转换成通用 feed 字段', () => {
    const snapshot = __testables.normalizeSnapshot(
      {
        fetchedAt: 123,
        digest: '今日摘要',
        items: [
          {
            id: 'n1',
            title: '旧格式标题',
            link: 'https://example.com/1',
            source: '来源',
            pubTs: 100,
            excerpt: '旧格式摘要',
          },
        ],
      },
      'news',
    )

    expect(snapshot).toEqual({
      feedId: 'news',
      title: '最近资讯',
      updatedAt: 123,
      summary: '今日摘要',
      items: [
        {
          id: 'n1',
          title: '旧格式标题',
          href: 'https://example.com/1',
          source: '来源',
          timestamp: 100,
          summary: '旧格式摘要',
        },
      ],
    })
  })

  it('相同 href/id 的多条资讯会生成唯一 id，避免 React key 冲突', () => {
    const snapshot = __testables.normalizeSnapshot(
      {
        items: [
          { title: '广播 1', href: 'http://www.xinhuanet.com/guangbo/' },
          { title: '广播 2', href: 'http://www.xinhuanet.com/guangbo/' },
          { title: '独立稿', href: 'https://example.com/unique' },
        ],
      },
      'news',
    )

    const ids = snapshot?.items.map((item) => item.id) ?? []
    expect(ids).toEqual([
      'http://www.xinhuanet.com/guangbo/',
      'http://www.xinhuanet.com/guangbo/#1',
      'https://example.com/unique',
    ])
    expect(new Set(ids).size).toBe(3)
  })

  it('没有新 feed 文件时从旧 news/latest.json 读取', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lumii-feed-test-'))
    const previousRoot = process.env.LUMII_CLIENT_DATA_DIR
    process.env.LUMII_CLIENT_DATA_DIR = root

    try {
      const legacyDir = path.join(root, 'news')
      await mkdir(legacyDir, { recursive: true })
      await writeFile(
        path.join(legacyDir, 'latest.json'),
        JSON.stringify({
          fetchedAt: 456,
          items: [{ title: '旧新闻', link: 'https://example.com/old' }],
        }),
        'utf8',
      )

      await expect(readDashboardFeedSnapshot('news')).resolves.toMatchObject({
        feedId: 'news',
        updatedAt: 456,
        items: [{ title: '旧新闻', href: 'https://example.com/old' }],
      })
    } finally {
      if (previousRoot === undefined) delete process.env.LUMII_CLIENT_DATA_DIR
      else process.env.LUMII_CLIENT_DATA_DIR = previousRoot
      await rm(root, { recursive: true, force: true })
    }
  })
})
