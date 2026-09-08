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
  ensureDashboardFeedMigrated,
  MAX_FEED_ITEMS,
  type DashboardFeedSnapshot,
} from './dashboard-feed-store'

function createFeedDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter()
  // 只建 feed 两表（V35 的表），其余 migration 不必全跑
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_feed_meta (
      feed_id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dashboard_feed_items (
      id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT,
      href TEXT, source TEXT, kind TEXT, timestamp INTEGER NOT NULL, metadata TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dfi_feed_ts ON dashboard_feed_items (feed_id, timestamp DESC, id);
  `)
  return db
}

function snapshotWith(items: DashboardFeedSnapshot['items'], updatedAt = 1000): DashboardFeedSnapshot {
  return { feedId: 'news', title: '最近资讯', updatedAt, items }
}

afterEach(() => {
  setDashboardFeedDb(null as unknown as DatabaseAdapter)
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
