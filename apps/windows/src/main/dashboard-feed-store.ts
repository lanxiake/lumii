/**
 * Dashboard feed 的通用存储协议。
 *
 * Dashboard 只消费这份规范化数据，不关心内容来自 RSS、飞书、工作日报
 * 还是用户自己注册的工作流。新闻只是默认的一个 feed。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from './client-data-root'

export const DEFAULT_DASHBOARD_FEED_ID = 'news'

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

function normalizeItem(raw: unknown, index: number): DashboardFeedItem | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const title = asNonEmptyString(value.title)
  if (!title) return null

  const href = asNonEmptyString(value.href) ?? asNonEmptyString(value.link)
  const summary = asNonEmptyString(value.summary) ?? asNonEmptyString(value.excerpt)
  const timestamp = asFiniteNumber(value.timestamp) ?? asFiniteNumber(value.pubTs)
  const id = asNonEmptyString(value.id) ?? href ?? `${title}-${index}`

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

  const items = value.items
    .map((item, index) => normalizeItem(item, index))
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

/** 读取指定 feed 的最新快照；news 会兼容旧版 ~/.lumii/news/latest.json。 */
export async function readDashboardFeedSnapshot(
  feedId = DEFAULT_DASHBOARD_FEED_ID,
): Promise<DashboardFeedSnapshot | null> {
  const normalizedId = validateFeedId(feedId)
  const current = await readJson(feedSnapshotPath(normalizedId))
  const currentSnapshot = normalizeSnapshot(current, normalizedId)
  if (currentSnapshot) return currentSnapshot

  if (normalizedId === DEFAULT_DASHBOARD_FEED_ID) {
    return normalizeSnapshot(await readJson(legacyNewsPath()), normalizedId)
  }
  return null
}

/** 写入工作流产出的规范化 Dashboard feed 快照。 */
export async function writeDashboardFeedSnapshot(snapshot: DashboardFeedSnapshot): Promise<void> {
  const feedId = validateFeedId(snapshot.feedId)
  const normalized = normalizeSnapshot(snapshot, feedId)
  if (!normalized) throw new Error('Dashboard feed 快照无有效条目结构')
  await writeJsonAtomically(feedSnapshotPath(feedId), normalized)
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
 * 独立 feed 用户根本看不到。代价是下次资讯抓取会整体重建 news feed 覆盖掉这条，
 * 需要长期留存就得让 feed 支持多来源合并。
 */
export async function prependActiveDashboardFeedItem(
  item: DashboardFeedItem,
  maxItems = 30,
): Promise<void> {
  const feedId = await readActiveDashboardFeedId()
  const existing = await readDashboardFeedSnapshot(feedId)
  await writeDashboardFeedSnapshot({
    feedId,
    title: existing?.title ?? (feedId === DEFAULT_DASHBOARD_FEED_ID ? '最近资讯' : feedId),
    updatedAt: Date.now(),
    ...(existing?.summary ? { summary: existing.summary } : {}),
    items: [item, ...(existing?.items ?? []).filter((i) => i.id !== item.id)].slice(0, maxItems),
  })
}

export const __testables = {
  normalizeItem,
  normalizeSnapshot,
  validateFeedId,
}
