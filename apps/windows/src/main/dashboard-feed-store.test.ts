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

describe('normalizeSource', () => {
  const { normalizeSource } = __testables

  it('把同一件事的几种分隔符写法收成一种', () => {
    // 实测：这三个在库里是三个不同的 key
    expect(normalizeSource('36氪/新智元')).toBe('36氪·新智元')
    expect(normalizeSource('36氪 / 新智元')).toBe('36氪·新智元')
    expect(normalizeSource('36氪·新智元')).toBe('36氪·新智元')
  })

  it('全角与竖线也收', () => {
    expect(normalizeSource('36氪／新智元')).toBe('36氪·新智元')
    expect(normalizeSource('36氪｜新智元')).toBe('36氪·新智元')
  })

  it('已有的 · 只规整它两侧的空格', () => {
    expect(normalizeSource('澎湃新闻 · 10%公司')).toBe('澎湃新闻·10%公司')
  })

  it('不重排顺序（谁是媒体谁是转载源代码判不了，重排等于把猜测写成事实）', () => {
    expect(normalizeSource('机器之心 / 36氪')).toBe('机器之心·36氪')
    expect(normalizeSource('36氪 / 机器之心')).toBe('36氪·机器之心')
  })

  it('不合并媒体名（InfoQ 与 InfoQ 中文是两家站点，不是写法差异）', () => {
    expect(normalizeSource('InfoQ 中文')).toBe('InfoQ 中文')
    expect(normalizeSource('The Verge')).toBe('The Verge')
  })

  it('多段分隔符连着写也只留一个 ·', () => {
    expect(normalizeSource('A / / B')).toBe('A·B')
    expect(normalizeSource('A  ·  ·  B')).toBe('A·B')
  })

  it('首尾多余的分隔符去掉', () => {
    expect(normalizeSource('/ 36氪')).toBe('36氪')
    expect(normalizeSource('36氪 /')).toBe('36氪')
  })

  it('空白与空串返回 undefined（而不是空字符串这种「有值但没内容」）', () => {
    expect(normalizeSource('')).toBeUndefined()
    expect(normalizeSource('   ')).toBeUndefined()
    expect(normalizeSource(undefined)).toBeUndefined()
  })

  it('经写入口生效：normalizeSnapshot 产出已归一化的 source', () => {
    const snapshot = __testables.normalizeSnapshot(
      { feedId: 'news', title: 't', updatedAt: 1, items: [{ title: 'a', source: '36氪 / 新智元' }] },
      'news',
    )
    expect(snapshot?.items[0]?.source).toBe('36氪·新智元')
  })
})
