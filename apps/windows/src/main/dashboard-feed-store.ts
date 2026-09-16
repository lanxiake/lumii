/**
 * Dashboard feed 的通用存储协议。
 *
 * Dashboard 只消费这份规范化数据，不关心内容来自 RSS、飞书、工作日报
 * 还是用户自己注册的工作流。新闻只是默认的一个 feed。
 *
 * 存储：SQLite（dashboard_feed_meta + dashboard_feed_items，schema V35）累积历史，
 * 每 feed 最多 1000 条，支持游标分页读。db 未注入（如某些测试/早期调用）时，
 * 读路径回退旧文件只读兼容。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { resolveWindowsClientDataRoot } from './client-data-root'

export const DEFAULT_DASHBOARD_FEED_ID = 'news'

/** 每个 feed 最多保留的条目数（概览页滑动分页上限） */
export const MAX_FEED_ITEMS = 1000

/**
 * 写盘版本计数。每次 writeDashboardFeedSnapshot 成功 +1，
 * 供 cron 调度器判断「本次任务运行期间是否写入了 feed」——
 * 资讯任务的结果落在 feed 里而非 Agent 文本回复，靠这个版本号识别。
 */
let feedWriteVersion = 0

/** 期 id 的进程内自增序号：让同一毫秒内写出的多期也有稳定顺序（见 writeDashboardFeedSnapshot） */
let batchSeq = 0

/** 读取当前写盘版本，跨模块用。 */
export function getDashboardFeedWriteVersion(): number {
  return feedWriteVersion
}

/** 模块级 db 注入（由 bridge.initialize 打开数据库后调用） */
let dashboardFeedDb: DatabaseAdapter | null = null

export function setDashboardFeedDb(db: DatabaseAdapter): void {
  dashboardFeedDb = db
}

export function getDashboardFeedDb(): DatabaseAdapter | null {
  return dashboardFeedDb
}

export type DashboardFeedMetadata = Record<string, string | number | boolean | null>

export interface DashboardFeedItem {
  id: string
  title: string
  summary?: string
  href?: string
  source?: string
  timestamp?: number
  /** 用户工作流可以用 kind 区分日报、任务、资讯等条目类型。 */
  kind?: string
  metadata?: DashboardFeedMetadata
}

export interface DashboardFeedSnapshot {
  feedId: string
  title: string
  updatedAt: number
  summary?: string
  items: DashboardFeedItem[]
  /**
   * 这一批的出处（可选）。每次 write 调用 = 一期，期上记着综述、来源与会话，
   * 才能回答「这条是谁什么时候推的」，也让综述不再随下次抓取被覆盖掉。
   */
  batch?: {
    /** 'agent'（Agent 主动推）| 'cron'（定时任务推送）| 'manual' | 'legacy'（V43 前的历史回填） */
    source?: string
    /** 出自哪个会话，用于从卡片跳回当时的对话 */
    conversationId?: string
  }
}

/** 一期推送：一段时间的条目 + 这一期自己的综述 */
export interface DashboardFeedBatch {
  id: string
  feedId: string
  /** 本期综述；legacy 回填的历史期为 null */
  summary?: string
  source: string
  conversationId?: string
  createdAt: string
  items: DashboardFeedItem[]
}

/** 游标分页游标：上一页最后一条的 (timestamp, id) */
export interface DashboardFeedCursor {
  timestamp: number
  id: string
}

export interface DashboardFeedPage {
  feedId: string
  items: DashboardFeedItem[]
  nextCursor: DashboardFeedCursor | null
}

/** 按期分页游标：上一期最后一条的 (created_at, id)，与条目游标分开是因为期的时间是 ISO 串 */
export interface DashboardFeedBatchCursor {
  createdAt: string
  id: string
}

/** 按期分页：一期为一组，返回的游标指向「比这批更早的期」 */
export interface DashboardFeedBatchPage {
  feedId: string
  batches: DashboardFeedBatch[]
  nextCursor: DashboardFeedBatchCursor | null
}

/** feed 元信息（标题/综述/更新时间），供概览页头部展示，不与条目一起全量读取 */
export interface DashboardFeedMeta {
  feedId: string
  title: string
  updatedAt: number
  summary?: string
}

interface DashboardFeedSelection {
  feedId: string
}

function feedRoot(): string {
  return path.join(resolveWindowsClientDataRoot(), 'dashboard-feed')
}

function activeFeedPath(): string {
  return path.join(feedRoot(), 'active.json')
}

function legacyNewsPath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'news', 'latest.json')
}

function validateFeedId(feedId: string): string {
  const normalized = feedId.trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(normalized)) {
    throw new Error(`非法 Dashboard feed id: ${feedId}`)
  }
  return normalized
}

function feedSnapshotPath(feedId: string): string {
  return path.join(feedRoot(), validateFeedId(feedId), 'latest.json')
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 为资讯条目生成唯一 id。优先已有 id / href；同一基准重复出现时追加 #n。
 */
export function uniqueDashboardFeedItemId(
  item: { id?: string; href?: string; title: string },
  index: number,
  seen: Map<string, number>,
): string {
  const base = item.id?.trim() || item.href?.trim() || `${item.title}-${index}`
  const count = seen.get(base) ?? 0
  seen.set(base, count + 1)
  return count === 0 ? base : `${base}#${count}`
}

function normalizeMetadata(value: unknown): DashboardFeedMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const metadata: DashboardFeedMetadata = {}
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === 'string'
      || typeof item === 'number'
      || typeof item === 'boolean'
      || item === null
    ) {
      metadata[key] = item
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

function normalizeItem(
  raw: unknown,
  index: number,
  seen: Map<string, number>,
): DashboardFeedItem | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const title = asNonEmptyString(value.title)
  if (!title) return null

  const href = asNonEmptyString(value.href) ?? asNonEmptyString(value.link)
  const summary = asNonEmptyString(value.summary) ?? asNonEmptyString(value.excerpt)
  const timestamp = asFiniteNumber(value.timestamp) ?? asFiniteNumber(value.pubTs)
  const id = uniqueDashboardFeedItemId(
    { id: asNonEmptyString(value.id), href, title },
    index,
    seen,
  )

  return {
    id,
    title,
    ...(summary ? { summary } : {}),
    ...(href ? { href } : {}),
    ...(asNonEmptyString(value.source) ? { source: asNonEmptyString(value.source) } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(asNonEmptyString(value.kind) ? { kind: asNonEmptyString(value.kind) } : {}),
    ...(normalizeMetadata(value.metadata) ? { metadata: normalizeMetadata(value.metadata) } : {}),
  }
}

function normalizeSnapshot(raw: unknown, fallbackFeedId: string): DashboardFeedSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.items)) return null

  const seenIds = new Map<string, number>()
  const items = value.items
    .map((item, index) => normalizeItem(item, index, seenIds))
    .filter((item): item is DashboardFeedItem => item !== null)
  const feedId = asNonEmptyString(value.feedId) ?? fallbackFeedId
  const title = asNonEmptyString(value.title) ?? (feedId === 'news' ? '最近资讯' : feedId)
  const updatedAt =
    asFiniteNumber(value.updatedAt)
    ?? asFiniteNumber(value.fetchedAt)
    ?? Date.now()
  const summary = asNonEmptyString(value.summary) ?? asNonEmptyString(value.digest)

  return {
    feedId,
    title,
    updatedAt,
    ...(summary ? { summary } : {}),
    items,
  }
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
  } catch {
    return null
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(tempPath, filePath)
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
  }
}

// ── DB 行 → 领域模型 ──────────────────────────────────────

interface FeedItemRow {
  id: string
  title: string
  summary: string | null
  href: string | null
  source: string | null
  kind: string | null
  timestamp: number
  metadata: string | null
}

function rowToItem(row: FeedItemRow): DashboardFeedItem {
  const item: DashboardFeedItem = {
    id: row.id,
    title: row.title,
    timestamp: row.timestamp,
  }
  if (row.summary) item.summary = row.summary
  if (row.href) item.href = row.href
  if (row.source) item.source = row.source
  if (row.kind) item.kind = row.kind
  if (row.metadata) {
    try {
      const parsed = JSON.parse(row.metadata) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        item.metadata = parsed as DashboardFeedMetadata
      }
    } catch {
      // 损坏的 metadata 直接丢弃，不阻断读取
    }
  }
  return item
}

function metadataToJson(metadata: DashboardFeedMetadata | undefined): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null
  return JSON.stringify(metadata)
}

/** 读取指定 feed 的元信息（标题/综述/更新时间），不读条目。 */
export async function readDashboardFeedMeta(
  feedId = DEFAULT_DASHBOARD_FEED_ID,
): Promise<DashboardFeedMeta | null> {
  const normalizedId = validateFeedId(feedId)
  if (dashboardFeedDb) {
    const meta = dashboardFeedDb
      .prepare<{ title: string; summary: string | null; updated_at: number }>(
        `SELECT title, summary, updated_at FROM dashboard_feed_meta WHERE feed_id = ?`,
      )
      .get(normalizedId)
    if (meta) {
      return {
        feedId: normalizedId,
        title: meta.title,
        updatedAt: meta.updated_at,
        ...(meta.summary ? { summary: meta.summary } : {}),
      }
    }
  }
  const snapshot = await readDashboardFeedSnapshot(normalizedId)
  if (!snapshot) return null
  return {
    feedId: snapshot.feedId,
    title: snapshot.title,
    updatedAt: snapshot.updatedAt,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
  }
}

/** 读取指定 feed 的最新快照；news 会兼容旧版 ~/.lumii/news/latest.json。 */
export async function readDashboardFeedSnapshot(
  feedId = DEFAULT_DASHBOARD_FEED_ID,
): Promise<DashboardFeedSnapshot | null> {
  const normalizedId = validateFeedId(feedId)

  if (dashboardFeedDb) {
    const meta = dashboardFeedDb
      .prepare<{ title: string; summary: string | null; updated_at: number }>(
        `SELECT title, summary, updated_at FROM dashboard_feed_meta WHERE feed_id = ?`,
      )
      .get(normalizedId)
    if (meta) {
      const rows = dashboardFeedDb
        .prepare<FeedItemRow>(
          `SELECT id, title, summary, href, source, kind, timestamp, metadata
           FROM dashboard_feed_items
           WHERE feed_id = ?
           ORDER BY timestamp DESC, id DESC
           LIMIT ${MAX_FEED_ITEMS}`,
        )
        .all(normalizedId)
      return {
        feedId: normalizedId,
        title: meta.title,
        updatedAt: meta.updated_at,
        ...(meta.summary ? { summary: meta.summary } : {}),
        items: rows.map(rowToItem),
      }
    }
    // DB 里没有该 feed（如老库升级后尚未回填），回退旧文件只读兼容
  }

  const current = await readJson(feedSnapshotPath(normalizedId))
  const currentSnapshot = normalizeSnapshot(current, normalizedId)
  if (currentSnapshot) return currentSnapshot

  if (normalizedId === DEFAULT_DASHBOARD_FEED_ID) {
    return normalizeSnapshot(await readJson(legacyNewsPath()), normalizedId)
  }
  return null
}

/**
 * 游标分页读取 feed 条目（时间倒序）。before 传上一页最后一条的 (timestamp, id)，
 * 首次调用传 null。返回条目与下一页游标（无更多时为 null）。
 */
export async function readDashboardFeedPage(
  feedId = DEFAULT_DASHBOARD_FEED_ID,
  opts: { limit?: number; before?: DashboardFeedCursor | null } = {},
): Promise<DashboardFeedPage> {  const normalizedId = validateFeedId(feedId)
  const limit = Math.max(1, Math.min(opts.limit ?? 20, MAX_FEED_ITEMS))

  if (!dashboardFeedDb) {
    // db 未注入：回退读文件快照并一次性切页（保持接口可用）
    const snapshot = await readDashboardFeedSnapshot(normalizedId)
    const items = snapshot?.items ?? []
    return { feedId: normalizedId, items, nextCursor: null }
  }

  const before = opts.before ?? null
  const rows = before
    ? dashboardFeedDb
        .prepare<FeedItemRow>(
          `SELECT id, title, summary, href, source, kind, timestamp, metadata
           FROM dashboard_feed_items
           WHERE feed_id = ?
             AND (timestamp < ? OR (timestamp = ? AND id < ?))
           ORDER BY timestamp DESC, id DESC
           LIMIT ?`,
        )
        .all(normalizedId, before.timestamp, before.timestamp, before.id, limit)
    : dashboardFeedDb
        .prepare<FeedItemRow>(
          `SELECT id, title, summary, href, source, kind, timestamp, metadata
           FROM dashboard_feed_items
           WHERE feed_id = ?
           ORDER BY timestamp DESC, id DESC
           LIMIT ?`,
        )
        .all(normalizedId, limit)

  const items = rows.map(rowToItem)
  const last = rows.length === limit ? rows[rows.length - 1] : undefined
  const nextCursor = last ? { timestamp: last.timestamp, id: last.id } : null
  return { feedId: normalizedId, items, nextCursor }
}

interface BatchRow {
  id: string
  feed_id: string
  summary: string | null
  source: string
  conversation_id: string | null
  created_at: string
  item_count: number
}

/**
 * 按期读取（期刊视图）：一期为一组，期内条目按时间倒序全量返回。
 *
 * 期的游标用 `(created_at, id)`——与条目游标同形，但比较的是期本身的时间，
 * 因此翻页时不会因为某期条目多寡而错位。一期通常十几条，整期返回比再套一层
 * 条目分页更简单，也让「展开这一期」不需要二次请求。
 */
export async function readDashboardFeedBatches(
  feedId = DEFAULT_DASHBOARD_FEED_ID,
  opts: { limit?: number; before?: DashboardFeedBatchCursor | null } = {},
): Promise<DashboardFeedBatchPage> {
  const normalizedId = validateFeedId(feedId)
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 50))

  if (!dashboardFeedDb) {
    const snapshot = await readDashboardFeedSnapshot(normalizedId)
    const items = snapshot?.items ?? []
    return {
      feedId: normalizedId,
      batches: items.length
        ? [
            {
              id: 'legacy:file',
              feedId: normalizedId,
              source: 'legacy',
              createdAt: new Date(snapshot?.updatedAt ?? Date.now()).toISOString(),
              ...(snapshot?.summary ? { summary: snapshot.summary } : {}),
              items,
            },
          ]
        : [],
      nextCursor: null,
    }
  }

  const before = opts.before ?? null
  const batchRows = before
    ? dashboardFeedDb
        .prepare<BatchRow>(
          `SELECT b.id, b.feed_id, b.summary, b.source, b.conversation_id, b.created_at,
                  (SELECT COUNT(*) FROM dashboard_feed_items i WHERE i.batch_id = b.id) AS item_count
           FROM dashboard_feed_batches b
           WHERE b.feed_id = ?
             AND (b.created_at < ? OR (b.created_at = ? AND b.id < ?))
           ORDER BY b.created_at DESC, b.id DESC
           LIMIT ?`,
        )
        .all(normalizedId, before.createdAt, before.createdAt, before.id, limit)
    : dashboardFeedDb
        .prepare<BatchRow>(
          `SELECT b.id, b.feed_id, b.summary, b.source, b.conversation_id, b.created_at,
                  (SELECT COUNT(*) FROM dashboard_feed_items i WHERE i.batch_id = b.id) AS item_count
           FROM dashboard_feed_batches b
           WHERE b.feed_id = ?
           ORDER BY b.created_at DESC, b.id DESC
           LIMIT ?`,
        )
        .all(normalizedId, limit)

  const batches: DashboardFeedBatch[] = []
  for (const row of batchRows) {
    // 空期（条目已被 MAX_FEED_ITEMS 裁掉）不展示：它在 UI 上只是一行没有内容的标题
    if (row.item_count === 0) continue
    const items = dashboardFeedDb
      .prepare<FeedItemRow>(
        `SELECT id, title, summary, href, source, kind, timestamp, metadata
         FROM dashboard_feed_items
         WHERE batch_id = ?
         ORDER BY timestamp DESC, id DESC`,
      )
      .all(row.id)
      .map(rowToItem)
    batches.push({
      id: row.id,
      feedId: row.feed_id,
      source: row.source,
      createdAt: row.created_at,
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      items,
    })
  }

  const last = batchRows.length === limit ? batchRows[batchRows.length - 1] : undefined
  const nextCursor = last ? { createdAt: last.created_at, id: last.id } : null
  return { feedId: normalizedId, batches, nextCursor }
}

/**
 * 写入工作流产出的规范化 Dashboard feed 快照（DB 合并累积）。
 *
 * 按 id UPSERT 去重（同一条资讯多次抓取只保留一行，内容覆盖更新），
 * 时间倒序后裁剪到 MAX_FEED_ITEMS。db 未注入时回退旧文件覆盖写（兼容测试）。
 *
 * **时间戳只在首次写入时落定，重复抓到同一条不刷新**（`timestamp` 不参与 DO UPDATE）。
 * 写入方给的是「抓取时刻」，若每次抓取都覆盖它，一篇三天前的旧稿只要再次出现在搜索结果里
 * 就会被顶到卡片最前、并显示成「1 分钟前」——用户看到的是「新资讯」，实际是旧的。
 * 内容（标题/摘要/来源）仍按最新的覆盖更新，只是排序位置与时间显示保持不变。
 *
 * **每次调用 = 一期**（V43）：本期的综述记在 `dashboard_feed_batches` 上，不再覆盖上一期；
 * 条目在本期首次入库时打上 `batch_id`，此后重复抓到不会改期（与 timestamp 同理）。
 * 若本批条目全都是别期已有的（重复抓取），本期没有任何新成员，则把空期删掉，不留噪音。
 */
export async function writeDashboardFeedSnapshot(snapshot: DashboardFeedSnapshot): Promise<void> {
  const feedId = validateFeedId(snapshot.feedId)
  const normalized = normalizeSnapshot(snapshot, feedId)
  if (!normalized) throw new Error('Dashboard feed 快照无有效条目结构')

  if (!dashboardFeedDb) {
    await writeJsonAtomically(feedSnapshotPath(feedId), normalized)
    feedWriteVersion++
    return
  }

  const now = new Date().toISOString()
  // 期 id 必须**单调可排序**：分页游标是 (created_at, id)，而同一毫秒内可能连写两期
  // （重试、连跑），此时 created_at 相同、排序只能靠 id。用随机后缀兜底等于随机翻页，
  // 所以这里带一个进程内自增序号（补零后字典序 = 数值序）。
  batchSeq += 1
  const batchId = `batch-${Date.now()}-${String(batchSeq).padStart(6, '0')}`
  const upsertMeta = dashboardFeedDb.prepare(
    `INSERT INTO dashboard_feed_meta (feed_id, title, summary, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(feed_id) DO UPDATE SET
       title = excluded.title,
       summary = excluded.summary,
       updated_at = excluded.updated_at`,
  )
  const insertBatch = dashboardFeedDb.prepare(
    `INSERT INTO dashboard_feed_batches (id, feed_id, summary, source, conversation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const upsertItem = dashboardFeedDb.prepare(
    `INSERT INTO dashboard_feed_items
       (id, feed_id, title, summary, href, source, kind, timestamp, metadata, created_at, batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       feed_id = excluded.feed_id,
       title = excluded.title,
       summary = excluded.summary,
       href = excluded.href,
       source = excluded.source,
       kind = excluded.kind,
       metadata = excluded.metadata`,
  )

  const tx = (fn: () => void) => {
    dashboardFeedDb!.exec('BEGIN')
    try {
      fn()
      dashboardFeedDb!.exec('COMMIT')
    } catch (err) {
      dashboardFeedDb!.exec('ROLLBACK')
      throw err
    }
  }

  tx(() => {
    upsertMeta.run(feedId, normalized.title, normalized.summary ?? null, normalized.updatedAt)
    insertBatch.run(
      batchId,
      feedId,
      normalized.summary ?? null,
      snapshot.batch?.source ?? 'agent',
      snapshot.batch?.conversationId ?? null,
      now,
    )
    for (const item of normalized.items) {
      upsertItem.run(
        item.id,
        feedId,
        item.title,
        item.summary ?? null,
        item.href ?? null,
        item.source ?? null,
        item.kind ?? null,
        item.timestamp ?? normalized.updatedAt,
        metadataToJson(item.metadata),
        now,
        batchId,
      )
    }
    // 裁剪到 MAX_FEED_ITEMS：保留最新的 N 条，删除更旧的
    dashboardFeedDb!.prepare(
      `DELETE FROM dashboard_feed_items
       WHERE feed_id = ? AND id IN (
         SELECT id FROM dashboard_feed_items
         WHERE feed_id = ?
         ORDER BY timestamp DESC, id DESC
         LIMIT -1 OFFSET ?
       )`,
    ).run(feedId, feedId, MAX_FEED_ITEMS)
    // 本期没有任何新成员（整批都是别期已有的重复抓取）→ 删掉这个空期，不留噪音
    const members = dashboardFeedDb!
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM dashboard_feed_items WHERE batch_id = ?`)
      .get(batchId)
    if (!members || members.n === 0) {
      dashboardFeedDb!.prepare(`DELETE FROM dashboard_feed_batches WHERE id = ?`).run(batchId)
    }
  })

  feedWriteVersion++
}

/**
 * 该 feed 当前有多少条（不含已裁剪的）。
 * 供 `dashboard_feed_read` 回答「卡片上总共多少条」——只给分页条数会让模型
 * 以为看到的就是全部。db 未注入时回落到文件快照的长度。
 */
export function countDashboardFeedItems(feedId = DEFAULT_DASHBOARD_FEED_ID): number {
  const normalizedId = validateFeedId(feedId)
  if (!dashboardFeedDb) return 0
  const row = dashboardFeedDb
    .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM dashboard_feed_items WHERE feed_id = ?`)
    .get(normalizedId)
  return row?.n ?? 0
}

export async function readActiveDashboardFeedId(): Promise<string> {
  const selection = await readJson(activeFeedPath())
  if (selection && typeof selection === 'object') {
    const feedId = asNonEmptyString((selection as DashboardFeedSelection).feedId)
    if (feedId) {
      try {
        return validateFeedId(feedId)
      } catch {
        // 配置损坏时回落默认 feed，避免概览页整体不可用。
      }
    }
  }
  return DEFAULT_DASHBOARD_FEED_ID
}

export async function setActiveDashboardFeedId(feedId: string): Promise<void> {
  await writeJsonAtomically(activeFeedPath(), { feedId: validateFeedId(feedId) } satisfies DashboardFeedSelection)
}

export async function readActiveDashboardFeedSnapshot(): Promise<DashboardFeedSnapshot | null> {
  return readDashboardFeedSnapshot(await readActiveDashboardFeedId())
}

/**
 * 向当前活跃 feed 头部插入一条内容（定时任务结果推送用）。
 *
 * 写活跃 feed 而不是独立的 cron feed：概览页只渲染活跃 feed，
 * 独立 feed 用户根本看不到。这条自成一期（source='cron'），
 * 因此它与资讯抓取各自的综述不会互相覆盖。
 */
export async function prependActiveDashboardFeedItem(
  item: DashboardFeedItem,
  maxItems = 30,
  batch: { source?: string; conversationId?: string } = { source: 'cron' },
): Promise<void> {
  const feedId = await readActiveDashboardFeedId()
  const existing = await readDashboardFeedSnapshot(feedId)
  await writeDashboardFeedSnapshot({
    feedId,
    title: existing?.title ?? (feedId === DEFAULT_DASHBOARD_FEED_ID ? '最近资讯' : feedId),
    updatedAt: Date.now(),
    ...(existing?.summary ? { summary: existing.summary } : {}),
    batch,
    items: [item, ...(existing?.items ?? []).filter((i) => i.id !== item.id)].slice(0, maxItems),
  })
}

/**
 * 一次性回填：老库升级到 V35 后，若 dashboard_feed_meta 无该 feed 且旧 latest.json 存在，
 * 导入旧快照到 DB。幂等（DB 已有该 feed 即跳过），由首个 dashboard-feed:* IPC 调用触发。
 */
export async function ensureDashboardFeedMigrated(feedId = DEFAULT_DASHBOARD_FEED_ID): Promise<void> {
  if (!dashboardFeedDb) return
  const normalizedId = validateFeedId(feedId)
  const meta = dashboardFeedDb
    .prepare<{ feed_id: string }>(`SELECT feed_id FROM dashboard_feed_meta WHERE feed_id = ?`)
    .get(normalizedId)
  if (meta) return

  const legacy = normalizeSnapshot(
    await readJson(feedSnapshotPath(normalizedId)),
    normalizedId,
  ) ?? (normalizedId === DEFAULT_DASHBOARD_FEED_ID
    ? normalizeSnapshot(await readJson(legacyNewsPath()), normalizedId)
    : null)
  if (legacy) {
    await writeDashboardFeedSnapshot(legacy)
  }
}

export const __testables = {
  normalizeItem,
  normalizeSnapshot,
  validateFeedId,
  uniqueDashboardFeedItemId,
  MAX_FEED_ITEMS,
}
