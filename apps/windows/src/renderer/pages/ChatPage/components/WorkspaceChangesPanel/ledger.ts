/**
 * 会话变更台账的纯计算层。
 *
 * 数据不做新表：每轮 assistant 消息的 `fileChanges` 已经持久化在
 * `assistant_parts.content_json` 里，实时事件也会写回内存消息。
 * 这里只负责把消息聚成「按轮分组 + 全会话去重统计 + 产物分批」，
 * 方便组件与测试复用。
 */

import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'

/** 面板可用的最小消息形状（RuntimeMessage 结构上兼容） */
export interface LedgerMessageLike {
  readonly id: string
  readonly role: string
  readonly timestamp: number
  readonly fileChanges?: readonly FileChangeEntry[]
  readonly sourceAgent?: { readonly label: string }
}

export type ChangeFilter = 'all' | 'added' | 'modified' | 'deleted'

export interface LedgerTurn {
  messageId: string
  timestamp: number
  /** 子 Agent 标签；主 Agent 为 undefined */
  sourceLabel?: string
  changes: readonly FileChangeEntry[]
}

export interface LedgerCounts {
  /** 全会话去重后的文件数（同一路径取最新一轮的状态） */
  files: number
  added: number
  modified: number
  deleted: number
}

export interface ArtifactItem {
  path: string
  status: FileChangeEntry['status']
  sourceTool?: string
  timestamp: number
}

/** 一批产物：同一目录下的媒体文件 */
export interface ArtifactBatch {
  dir: string
  items: ArtifactItem[]
}

export interface ChangeLedger {
  /** 按时间倒序的轮次 */
  turns: LedgerTurn[]
  counts: LedgerCounts
  /** 按目录分批，批次与批内条目都按最新优先 */
  artifacts: ArtifactBatch[]
  artifactCount: number
}

const EMPTY_COUNTS: LedgerCounts = {
  files: 0,
  added: 0,
  modified: 0,
  deleted: 0,
}

const MEDIA_EXTENSIONS = new Set([
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg',
  // 视频
  'mp4', 'mov', 'webm', 'mkv', 'avi',
  // 音频
  'mp3', 'wav', 'm4a', 'ogg', 'flac',
])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'])

/** 取小写扩展名（无扩展名返回空串） */
export function extOf(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function isMediaPath(filePath: string): boolean {
  return MEDIA_EXTENSIONS.has(extOf(filePath))
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extOf(filePath))
}

/** 所在目录（posix 相对路径）；根目录返回空串 */
export function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash >= 0 ? filePath.slice(0, slash) : ''
}

/** 构造 lumii-local 媒体 URL（与主进程 buildLocalMediaUrl 一致） */
export function mediaUrl(absolutePath: string): string {
  return `lumii-local://media/?path=${encodeURIComponent(absolutePath)}`
}

/** HH:mm，用于轮次标题 */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 只保留本会话能佐证的条目；旧数据里的 unattributed 条目在这里统一过滤掉 */
function ownedChanges(message: LedgerMessageLike): readonly FileChangeEntry[] {
  return (message.fileChanges ?? []).filter((entry) => entry.confidence !== 'unattributed')
}

/**
 * 从会话消息构建台账。
 *
 * - turns：每轮有变更的 assistant 消息，倒序；
 * - counts：全会话按路径去重，取最新一轮的状态；
 * - artifacts：未删除的媒体文件，按目录分批（同一路径只保留最新一次）。
 */
export function buildChangeLedger(messages: readonly LedgerMessageLike[]): ChangeLedger {
  const turns: LedgerTurn[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const changes = ownedChanges(message)
    if (changes.length === 0) continue
    turns.push({
      messageId: message.id,
      timestamp: message.timestamp,
      ...(message.sourceAgent?.label ? { sourceLabel: message.sourceAgent.label } : {}),
      changes,
    })
  }
  turns.sort((a, b) => b.timestamp - a.timestamp)

  // 最新状态：按时间正序扫描，后出现的覆盖先出现的
  const chronological = [...messages].sort((a, b) => a.timestamp - b.timestamp)
  const latest = new Map<string, FileChangeEntry>()
  for (const message of chronological) {
    for (const entry of ownedChanges(message)) latest.set(entry.path, entry)
  }

  const counts: LedgerCounts = { ...EMPTY_COUNTS, files: latest.size }
  for (const entry of latest.values()) {
    if (entry.status === 'added') counts.added += 1
    else if (entry.status === 'modified') counts.modified += 1
    else if (entry.status === 'deleted') counts.deleted += 1
  }

  const batches = new Map<string, ArtifactItem[]>()
  const seen = new Set<string>()
  for (const turn of turns) {
    for (const entry of turn.changes) {
      if (entry.status === 'deleted' || !isMediaPath(entry.path)) continue
      if (seen.has(entry.path)) continue
      seen.add(entry.path)
      const dir = dirOf(entry.path)
      const item: ArtifactItem = {
        path: entry.path,
        status: entry.status,
        ...(entry.sourceTool ? { sourceTool: entry.sourceTool } : {}),
        timestamp: turn.timestamp,
      }
      const bucket = batches.get(dir)
      if (bucket) bucket.push(item)
      else batches.set(dir, [item])
    }
  }

  return {
    turns,
    counts,
    artifacts: [...batches].map(([dir, items]) => ({ dir, items })),
    artifactCount: seen.size,
  }
}

interface FilterableEntry {
  status: FileChangeEntry['status']
}

export function matchesFilter(entry: FilterableEntry, filter: ChangeFilter): boolean {
  return filter === 'all' || entry.status === filter
}

function matchesQuery(filePath: string, query: string): boolean {
  return !query || filePath.toLowerCase().includes(query)
}

/** 状态筛选 + 路径搜索；返回只含命中行的轮次 */
export function filterTurns(
  turns: readonly LedgerTurn[],
  filter: ChangeFilter,
  query: string,
): LedgerTurn[] {
  const needle = query.trim().toLowerCase()
  if (filter === 'all' && !needle) return [...turns]
  const out: LedgerTurn[] = []
  for (const turn of turns) {
    const changes = turn.changes.filter(
      (entry) => matchesFilter(entry, filter) && matchesQuery(entry.path, needle),
    )
    if (changes.length > 0) out.push({ ...turn, changes })
  }
  return out
}

/** 产物同样受筛选影响；空批次会被丢掉 */
export function filterArtifacts(
  batches: readonly ArtifactBatch[],
  filter: ChangeFilter,
  query: string,
): ArtifactBatch[] {
  const needle = query.trim().toLowerCase()
  if (filter === 'all' && !needle) return [...batches]
  const out: ArtifactBatch[] = []
  for (const batch of batches) {
    const items = batch.items.filter(
      (item) => matchesFilter(item, filter) && matchesQuery(item.path, needle),
    )
    if (items.length > 0) out.push({ dir: batch.dir, items })
  }
  return out
}
