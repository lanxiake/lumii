/**
 * dashboard-feed-store 的 SQLite 存储路径测试。
 *
 * 注入真实 node:sqlite 内存库（含 dashboard_feed 两表），验证：
 * - 写合并去重（同 id 覆盖更新）
 * - 截断到 MAX_FEED_ITEMS（1000）
 * - 游标分页读（readDashboardFeedPage）
 * - 老文件回填（ensureDashboardFeedMigrated）
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestSqliteAdapter } from '../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import {
  setDashboardFeedDb,
  getDashboardFeedDb,
  writeDashboardFeedSnapshot,
  readDashboardFeedSnapshot,
  readDashboardFeedPage,
  readDashboardFeedBatches,
  ensureDashboardFeedMigrated,
  MAX_FEED_ITEMS,
  type DashboardFeedSnapshot,
} from './dashboard-feed-store'

function createFeedDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter()
  // 只建 feed 两表 + V43 的期表，其余 migration 不必全跑
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_feed_meta (
      feed_id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dashboard_feed_items (
      id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT,
      href TEXT, source TEXT, kind TEXT, timestamp INTEGER NOT NULL, metadata TEXT, created_at TEXT NOT NULL,
      batch_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dfi_feed_ts ON dashboard_feed_items (feed_id, timestamp DESC, id);
    CREATE TABLE IF NOT EXISTS dashboard_feed_batches (
      id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, summary TEXT,
      source TEXT NOT NULL DEFAULT 'agent', conversation_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dfb_feed ON dashboard_feed_batches (feed_id, created_at DESC, id DESC);
  `)
  return db
}

function snapshotWith(items: DashboardFeedSnapshot['items'], updatedAt = 1000): DashboardFeedSnapshot {
  return { feedId: 'news', title: '最近资讯', updatedAt, items }
}

afterEach(() => {
  setDashboardFeedDb(null as unknown as DatabaseAdapter)
})

describe('dashboard-feed-store 按期（期刊）', () => {
  it('每次写入成一期：各自的综述与条目互不覆盖', async () => {
    const db = createFeedDb()
    setDashboardFeedDb(db)

    await writeDashboardFeedSnapshot({
      ...snapshotWith([{ id: 'a', title: '第一期条目', timestamp: 100 }]),
      summary: '第一期综述',
      batch: { source: 'agent', conversationId: 'cron:news' },
    })
    await writeDashboardFeedSnapshot({
      ...snapshotWith([{ id: 'b', title: '第二期条目', timestamp: 200 }], 2000),
      summary: '第二期综述',
      batch: { source: 'agent' },
    })

    const page = await readDashboardFeedBatches('news', { limit: 5 })
    expect(page.batches).toHaveLength(2)
    // 最新一期在前
    expect(page.batches[0].summary).toBe('第二期综述')
    expect(page.batches[0].items.map((i) => i.id)).toEqual(['b'])
    // 上一期的综述没有被覆盖——这正是建期的理由
    expect(page.batches[1].summary).toBe('第一期综述')
    expect(page.batches[1].conversationId).toBe('cron:news')
    db.close()
  })

  it('重复抓到的条目留在原来那一期，不跳到最新一期', async () => {
    const db = createFeedDb()
    setDashboardFeedDb(db)

    await writeDashboardFeedSnapshot({
      ...snapshotWith([{ id: 'old', title: '第一篇', timestamp: 100 }]),
      batch: { source: 'agent' },
    })
    // 第二轮又抓到同一篇（外加一条新的）
    await writeDashboardFeedSnapshot({
      ...snapshotWith([
        { id: 'old', title: '第一篇', timestamp: 999 },
        { id: 'new', title: '新的一篇', timestamp: 500 },
      ], 2000),
      batch: { source: 'agent' },
    })

    const page = await readDashboardFeedBatches('news', { limit: 5 })
    const first = page.batches.find((b) => b.items.some((i) => i.id === 'old'))
    expect(first?.items.map((i) => i.id)).toEqual(['old'])
    expect(page.batches[0].items.map((i) => i.id)).toEqual(['new'])
    db.close()
  })

  it('整批都是旧条目时不留空期', async () => {
    const db = createFeedDb()
    setDashboardFeedDb(db)

    await writeDashboardFeedSnapshot({
      ...snapshotWith([{ id: 'a', title: '甲', timestamp: 100 }]),
      batch: { source: 'agent' },
    })
    await writeDashboardFeedSnapshot({
      ...snapshotWith([{ id: 'a', title: '甲', timestamp: 100 }], 2000),
      batch: { source: 'agent' },
    })

    const page = await readDashboardFeedBatches('news', { limit: 5 })
    expect(page.batches).toHaveLength(1)
    const rows = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM dashboard_feed_batches`).get()
    expect(rows?.n).toBe(1)
    db.close()
  })

  it('按期分页：游标指向更早的期，翻页不重不漏', async () => {
    const db = createFeedDb()
    setDashboardFeedDb(db)
    for (let i = 0; i < 5; i += 1) {
      await writeDashboardFeedSnapshot({
        ...snapshotWith([{ id: `item-${i}`, title: `t${i}`, timestamp: 100 + i }], 1000 + i),
        summary: `第 ${i} 期`,
        batch: { source: 'agent' },
      })
    }

    const first = await readDashboardFeedBatches('news', { limit: 2 })
    expect(first.batches.map((b) => b.summary)).toEqual(['第 4 期', '第 3 期'])
    expect(first.nextCursor).not.toBeNull()

    const second = await readDashboardFeedBatches('news', { limit: 2, before: first.nextCursor })
    expect(second.batches.map((b) => b.summary)).toEqual(['第 2 期', '第 1 期'])
    expect(second.nextCursor).not.toBeNull()

    const third = await readDashboardFeedBatches('news', { limit: 2, before: second.nextCursor })
    expect(third.batches.map((b) => b.summary)).toEqual(['第 0 期'])
    expect(third.nextCursor).toBeNull()
    db.close()
  })

  it('条目被裁掉后不留孤儿期（空期不展示）', async () => {
    const db = createFeedDb()
    setDashboardFeedDb(db)
    await writeDashboardFeedSnapshot({
      ...snapshotWith([{ id: 'a', title: '甲', timestamp: 100 }]),
      batch: { source: 'agent' },
    })
    // 模拟裁剪把该期条目删光
    db.prepare(`DELETE FROM dashboard_feed_items`).run()

    const page = await readDashboardFeedBatches('news', { limit: 5 })
    expect(page.batches).toHaveLength(0)
    db.close()
  })
})

describe('dashboard-feed-store (SQLite)', () => {
  it('写两次同 id 条目会合并去重，内容覆盖更新', async () => {
    const db = createFeedDb()
    setDashboardFeedDb(db)

    await writeDashboardFeedSnapshot(
      snapshotWith([{ id: 'a', title: '旧标题', timestamp: 100 }]),
    )
    await writeDashboardFeedSnapshot(
      snapshotWith([{ id: 'a', title: '新标题', timestamp: 100 }, { id: 'b', title: 'B', timestamp: 90 }]),
    )

    const snap = await readDashboardFeedSnapshot('news')
    expect(snap?.items).toHaveLength(2)
    expect(snap?.items.find((i) => i.id === 'a')?.title).toBe('新标题')
    db.close()
  })

  it('重复抓到同一条不刷新时间戳：旧稿不会被顶到最前、也不会显示成「刚刚」', async () => {
    const db = createFeedDb()
    setDashboardFeedDb(db)

    // 首次抓取：旧稿比新稿早
    await writeDashboardFeedSnapshot(
      snapshotWith([
        { id: 'old', title: '三天前的稿子', timestamp: 100 },
        { id: 'new', title: '今天的稿子', timestamp: 200 },
      ]),
    )
    // 第二轮抓取：同一篇旧稿又出现在搜索结果里，写入方给的是当下的抓取时刻
    await writeDashboardFeedSnapshot(
      snapshotWith([
        { id: 'old', title: '三天前的稿子（摘要更新）', timestamp: 999 },
        { id: 'newer', title: '更新的一条', timestamp: 300 },
      ]),
    )

    const snap = await readDashboardFeedSnapshot('news')
    const old = snap?.items.find((i) => i.id === 'old')
    // 时间戳保持首见时刻（排序位置与「N 天前」的显示都据此）
    expect(old?.timestamp).toBe(100)
    // 内容仍然按最新覆盖
    expect(old?.title).toBe('三天前的稿子（摘要更新）')
    // 因此旧稿不会挤到最前
    expect(snap?.items[snap.items.length - 1].id).toBe('old')
    db.close()
  })

  it('条目按时间倒序，最多保留 MAX_FEED_ITEMS 条', async () => {
    const db = createFeedDb()
    setDashboardFeedDb(db)

    const items = Array.from({ length: MAX_FEED_ITEMS + 50 }, (_, i) => ({
      id: `id-${i}`,
      title: `t${i}`,
      timestamp: i,
    }))
    await writeDashboardFeedSnapshot(snapshotWith(items))

    const snap = await readDashboardFeedSnapshot('news')
    expect(snap?.items).toHaveLength(MAX_FEED_ITEMS)
    // 最新的在前：timestamp 最大的 id-(MAX_FEED_ITEMS+49)
    expect(snap?.items[0].id).toBe(`id-${MAX_FEED_ITEMS + 49}`)
    // 最旧的（timestamp 最小的 50 条）已被裁掉
    expect(snap?.items.some((i) => i.id === 'id-0')).toBe(false)
    db.close()
  })

  it('readDashboardFeedPage 游标分页：首屏 + 翻页无重无漏', async () => {
    const db = createFeedDb()
    setDashboardFeedDb(db)

    const items = Array.from({ length: 30 }, (_, i) => ({
      id: `id-${i}`,
      title: `t${i}`,
      timestamp: i,
    }))
    await writeDashboardFeedSnapshot(snapshotWith(items))

    const page1 = await readDashboardFeedPage('news', { limit: 12 })
    expect(page1.items).toHaveLength(12)
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await readDashboardFeedPage('news', { limit: 12, before: page1.nextCursor })
    expect(page2.items).toHaveLength(12)

    const page3 = await readDashboardFeedPage('news', { limit: 12, before: page2.nextCursor })
    expect(page3.items).toHaveLength(6)
    expect(page3.nextCursor).toBeNull()

    const all = [...page1.items, ...page2.items, ...page3.items].map((i) => i.id)
    expect(new Set(all).size).toBe(30)
    db.close()
  })

  it('ensureDashboardFeedMigrated 把旧 news/latest.json 回填进 DB（幂等）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lumii-feed-migrate-'))
    const previousRoot = process.env.LUMII_CLIENT_DATA_DIR
    process.env.LUMII_CLIENT_DATA_DIR = root
    try {
      const legacyDir = path.join(root, 'news')
      await mkdir(legacyDir, { recursive: true })
      await writeFile(
        path.join(legacyDir, 'latest.json'),
        JSON.stringify({
          fetchedAt: 777,
          items: [{ title: '旧新闻', link: 'https://example.com/old' }],
        }),
        'utf8',
      )

      const db = createFeedDb()
      setDashboardFeedDb(db)

      await ensureDashboardFeedMigrated('news')
      let snap = await readDashboardFeedSnapshot('news')
      expect(snap?.items).toHaveLength(1)
      expect(snap?.updatedAt).toBe(777)

      // 幂等：再跑一次不重复导入
      await ensureDashboardFeedMigrated('news')
      snap = await readDashboardFeedSnapshot('news')
      expect(snap?.items).toHaveLength(1)
      db.close()
    } finally {
      if (previousRoot === undefined) delete process.env.LUMII_CLIENT_DATA_DIR
      else process.env.LUMII_CLIENT_DATA_DIR = previousRoot
      await rm(root, { recursive: true, force: true })
    }
  })

  it('getDashboardFeedDb 反映注入状态', () => {
    expect(getDashboardFeedDb()).toBeNull()
    const db = createFeedDb()
    setDashboardFeedDb(db)
    expect(getDashboardFeedDb()).toBe(db)
    db.close()
  })
})
