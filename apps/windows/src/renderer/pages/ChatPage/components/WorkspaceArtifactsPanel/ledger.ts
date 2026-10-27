/**
 * 会话变更 / 产物台账的纯计算层。
 *
 * 数据不做新表：每轮 assistant 消息的 `fileChanges` 已经持久化在
 * `assistant_parts.content_json` 里，实时事件也会写回内存消息。
 *
 * - `buildChangeLedger`：按轮分组 + 全会话去重统计（原始视角）；
 * - `buildArtifactLedger`：在它的基础上按「任务 × 目录」分组、分成品/中间产物、
 *   并记录同一路径的历史版本（工作台 rail 用这个）。
 */

import type {
  ArtifactDeclaration,
  ArtifactMeta,
  FileChangeEntry,
} from '@mtbot/agent-runtime/browser'
import {
  INTERMEDIATE_FOLD_THRESHOLD,
  classifyArtifact,
  extOf,
  kindOf,
  type ArtifactKind,
} from '../../../../../shared/artifact-rules'
import { readDeclarations } from '../../../../../shared/artifact-declaration'

/** 扩展名工具留在台账这一层给面板用（实现只有 shared 一份） */
export { extOf }

/** 面板可用的最小消息形状（RuntimeMessage 结构上兼容） */
export interface LedgerMessageLike {
  readonly id: string
  readonly role: string
  readonly timestamp: number
  readonly fileChanges?: readonly FileChangeEntry[]
  readonly sourceAgent?: { readonly label: string }
  /** user 消息的纯文本；用于任务组标签（renderer 侧从 content 拼接后传入） */
  readonly text?: string
  /** P1：tool part 的 `result.details.artifacts` 是产物声明（声明优先、派生兜底） */
  readonly parts?: readonly {
    readonly type: string
    readonly name?: string
    readonly result?: unknown
  }[]
}

interface DeclaredArtifact {
  declaration: ArtifactDeclaration & { path: string }
  turnId: string
  timestamp: number
  sourceTool?: string
  sourceLabel?: string
}

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

export interface ChangeLedger {
  /** 按时间倒序的轮次 */
  turns: LedgerTurn[]
  counts: LedgerCounts
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

export function isMediaPath(filePath: string): boolean {
  return MEDIA_EXTENSIONS.has(extOf(filePath))
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extOf(filePath))
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
 * 从会话消息构建变更台账。
 *
 * - turns：每轮有变更的 assistant 消息，倒序；
 * - counts：全会话按路径去重，取最新一轮的状态。
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

  return { turns, counts }
}

// ---------------------------------------------------------------------------
// 产物台账（工作台 rail）
// ---------------------------------------------------------------------------

export interface Artifact {
  /** 工作区相对路径 */
  path: string
  kind: ArtifactKind
  role: 'deliverable' | 'intermediate'
  status: FileChangeEntry['status']
  sourceTool?: string
  timestamp: number
  /** 最近一次写入它的 assistant 消息 id（「回到产生它的那条消息」用） */
  turnId: string
  /** 声明提供的元数据（尺寸/时长/模型/prompt 等） */
  meta?: ArtifactMeta
  /** 声明的展示标题（侧车可能给比文件名更好的标题） */
  title?: string
  /** 非工作区产物（ComfyUI 远端）；只展示，不打开/不清理 */
  remoteUrl?: string
  /** 「全部」作用域与跨会话跳转用 */
  conversationId?: string
  /** 来自工具显式声明：kind/role/meta 以声明为准，侧车不得覆盖 */
  declared?: boolean
  /** P2：最近一次写入来自工作台本地编辑（含手工保存）；本地新文件没有 turnId */
  origin?: 'local'
}

export interface ArtifactGroup {
  /** 分组键：产出目录（如 `outputs/pet-demo`） */
  key: string
  /** 前一用户消息首句（≤24 字）或 HH:mm */
  label: string
  /** 组内最新一轮的时间（倒序排序用） */
  timestamp: number
  /** 组内最早的轮次时间（标签来自它之前的那条用户消息） */
  startedAt: number
  sourceLabel?: string
  deliverables: Artifact[]
  intermediates: Artifact[]
}

export interface ArtifactVersion {
  /** P2：`turn:<messageId>` / `local:<editId>`；台账回退版本可能没有 */
  versionId?: string
  source?: 'turn' | 'local'
  turnId?: string
  timestamp: number
  status: FileChangeEntry['status'] | 'edited'
  /** P2：内容是否可取（列表阶段只推断，不读 blob） */
  content?: {
    available: boolean
    kind?: 'git' | 'store'
    approximate?: boolean
    reason?: string
  }
  pinned?: { pinId: string; at: number }
}

export interface ArtifactLedger {
  /** 倒序 */
  groups: ArtifactGroup[]
  counts: {
    deliverables: number
    intermediates: number
    byKind: Partial<Record<ArtifactKind, number>>
  }
  /** 同一路径在会话内的历史版本（时间正序） */
  versions: Map<string, ArtifactVersion[]>
}

/**
 * 任务分组键：`outputs/<项目>/…` 取前两段，其余取第一段。
 *
 * 同一目录跨回合追加产物（「再生成一张」）会合进同一组——用户心智里那是
 * 同一个任务，而不是两条并列记录。
 */
export function artifactGroupKey(filePath: string): string {
  const segments = filePath.split('/').filter(Boolean)
  const dirSegments = segments.slice(0, -1)
  if (dirSegments.length === 0) return ''
  if (dirSegments[0] === 'outputs' && dirSegments.length > 1) {
    return `outputs/${dirSegments[1]}`
  }
  return dirSegments[0]!
}

/** 用户首句 → 组标签：去 Markdown 标记、截断 24 字 */
export function labelFromText(text: string | undefined): string | undefined {
  if (!text) return undefined
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!firstLine) return undefined
  const cleaned = firstLine
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*>]\s+/, '')
    .replace(/^\[[ x]\]\s*/i, '')
    .replace(/[*_`~]/g, '')
    .trim()
  if (!cleaned) return undefined
  return cleaned.length > 24 ? `${cleaned.slice(0, 24)}…` : cleaned
}

/** 汇总工具声明：同路径取最新一次声明 */
function collectDeclaredArtifacts(
  messages: readonly LedgerMessageLike[],
): Map<string, DeclaredArtifact> {
  const out = new Map<string, DeclaredArtifact>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.parts) continue
    for (const part of message.parts) {
      if (part.type !== 'tool') continue
      for (const declaration of readDeclarations(part.result)) {
        if (!declaration.path) continue
        const role = classifyArtifact({ path: declaration.path })
        if (role === 'internal' || role === 'ephemeral') continue
        const existing = out.get(declaration.path)
        if (existing && existing.timestamp > message.timestamp) continue
        out.set(declaration.path, {
          declaration: { ...declaration, path: declaration.path },
          turnId: message.id,
          timestamp: message.timestamp,
          ...(part.name ? { sourceTool: part.name } : {}),
          ...(message.sourceAgent?.label ? { sourceLabel: message.sourceAgent.label } : {}),
        })
      }
    }
  }
  return out
}

/**
 * 从会话消息构建产物台账。
 *
 * 1. 复用 `buildChangeLedger().turns`（assistant + 已归属变更）；
 * 2. 按 `turnId + 目录` 归组，同目录跨轮合并；
 * 3. internal 丢弃（记账/缓存），ephemeral 不进 rail（temp/ 由清理功能负责）；
 * 4. 中间产物 ≥20 才折叠，否则按成品展示；
 * 5. 工具声明（details.artifacts）覆盖 kind/role/meta，并能补出 fileChanges 没记到的路径。
 */
export function buildArtifactLedger(
  messages: readonly LedgerMessageLike[],
): ArtifactLedger {
  const { turns } = buildChangeLedger(messages)

  // 每条 turn 的标签：它之前最近的一条 user 消息
  const userMessages = messages
    .filter((message) => message.role === 'user')
    .sort((a, b) => a.timestamp - b.timestamp)
  const labelOfTurn = (timestamp: number): string | undefined => {
    let found: string | undefined
    for (const message of userMessages) {
      if (message.timestamp > timestamp) break
      const label = labelFromText(message.text)
      if (label) found = label
    }
    return found
  }

  const versions = new Map<string, ArtifactVersion[]>()
  const groups = new Map<string, { group: ArtifactGroup; items: Map<string, Artifact> }>()

  const ensureSlot = (
    key: string,
    timestamp: number,
    sourceLabel?: string,
  ): { group: ArtifactGroup; items: Map<string, Artifact> } => {
    let slot = groups.get(key)
    if (!slot) {
      slot = {
        group: {
          key,
          label: labelOfTurn(timestamp) ?? formatClock(timestamp),
          timestamp,
          startedAt: timestamp,
          ...(sourceLabel ? { sourceLabel } : {}),
          deliverables: [],
          intermediates: [],
        },
        items: new Map(),
      }
      groups.set(key, slot)
      return slot
    }
    const group = slot.group
    // 组标签取**最早**那轮的上下文：它才说明这个任务是怎么开始的
    if (timestamp < group.startedAt) {
      group.startedAt = timestamp
      group.label = labelOfTurn(timestamp) ?? formatClock(timestamp)
    }
    if (timestamp > group.timestamp) group.timestamp = timestamp
    if (!group.sourceLabel && sourceLabel) group.sourceLabel = sourceLabel
    return slot
  }

  // 版本按时间正序记录；分组本身最后再按最新时间倒序
  const ascending = [...turns].sort((a, b) => a.timestamp - b.timestamp)

  for (const turn of ascending) {
    // 组内去重：同路径取最新一次写入
    for (const entry of turn.changes) {
      const role = classifyArtifact({ path: entry.path })
      if (role === 'internal' || role === 'ephemeral') continue
      const list = versions.get(entry.path)
      const version: ArtifactVersion = {
        turnId: turn.messageId,
        timestamp: turn.timestamp,
        status: entry.status,
      }
      if (list) list.push(version)
      else versions.set(entry.path, [version])
    }

    const byKey = new Map<string, FileChangeEntry[]>()
    for (const entry of turn.changes) {
      const role = classifyArtifact({ path: entry.path })
      if (role === 'internal' || role === 'ephemeral' || entry.status === 'deleted') continue
      const key = artifactGroupKey(entry.path)
      const bucket = byKey.get(key)
      if (bucket) bucket.push(entry)
      else byKey.set(key, [entry])
    }

    for (const [key, entries] of byKey) {
      const slot = ensureSlot(key, turn.timestamp, turn.sourceLabel)

      for (const entry of entries) {
        const existing = slot.items.get(entry.path)
        // 同路径后写覆盖前写
        if (existing && existing.timestamp > turn.timestamp) continue
        const artifact: Artifact = {
          path: entry.path,
          kind: kindOf(entry.path),
          role: classifyArtifact({ path: entry.path }) as Artifact['role'],
          status: entry.status,
          ...(entry.sourceTool ? { sourceTool: entry.sourceTool } : {}),
          timestamp: turn.timestamp,
          turnId: turn.messageId,
        }
        slot.items.set(entry.path, artifact)
      }
    }
  }

  // 工具声明：覆盖 kind/role/meta；fileChanges 没记到的路径也补卡（如直连生图/后台产物）
  const latestStatus = new Map<string, ArtifactVersion['status']>()
  for (const [path, list] of versions) {
    const last = list[list.length - 1]
    if (last) latestStatus.set(path, last.status)
  }
  const declared = collectDeclaredArtifacts(messages)
  for (const [path, info] of declared) {
    // 后续轮次已删除/改名的产物，不能因为历史里有声明又被加回 rail
    if (latestStatus.get(path) === 'deleted') continue
    const { declaration } = info
    const role: Artifact['role'] =
      declaration.role ??
      (classifyArtifact({ path }) === 'intermediate' ? 'intermediate' : 'deliverable')

    const list = versions.get(path)
    if (!list || !list.some((version) => version.turnId === info.turnId)) {
      const version: ArtifactVersion = {
        turnId: info.turnId,
        timestamp: info.timestamp,
        status: 'added',
      }
      if (list) list.push(version)
      else versions.set(path, [version])
    }

    const slot = ensureSlot(artifactGroupKey(path), info.timestamp, info.sourceLabel)
    const existing = slot.items.get(path)
    if (existing) {
      existing.kind = declaration.kind
      existing.role = role
      existing.declared = true
      if (declaration.meta) existing.meta = declaration.meta
      if (declaration.title) existing.title = declaration.title
      if (info.sourceTool) existing.sourceTool = info.sourceTool
      continue
    }
    slot.items.set(path, {
      path,
      kind: declaration.kind,
      role,
      status: 'added',
      timestamp: info.timestamp,
      turnId: info.turnId,
      declared: true,
      ...(info.sourceTool ? { sourceTool: info.sourceTool } : {}),
      ...(declaration.meta ? { meta: declaration.meta } : {}),
      ...(declaration.title ? { title: declaration.title } : {}),
      ...(declaration.remoteUrl ? { remoteUrl: declaration.remoteUrl } : {}),
    })
  }

  const byKind: Partial<Record<ArtifactKind, number>> = {}
  let deliverables = 0
  let intermediates = 0
  const out: ArtifactGroup[] = []

  for (const slot of groups.values()) {
    const items = [...slot.items.values()].sort((a, b) => a.path.localeCompare(b.path))
    const intermediateItems = items.filter((item) => item.role === 'intermediate')
    const fold = intermediateItems.length >= INTERMEDIATE_FOLD_THRESHOLD
    const group: ArtifactGroup = {
      ...slot.group,
      deliverables: fold
        ? items.filter((item) => item.role === 'deliverable')
        : items,
      intermediates: fold ? intermediateItems : [],
    }
    if (group.deliverables.length + group.intermediates.length === 0) continue

    for (const item of group.deliverables) {
      deliverables += 1
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    }
    for (const item of group.intermediates) {
      intermediates += 1
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    }
    out.push(group)
  }

  out.sort((a, b) => b.timestamp - a.timestamp)

  for (const list of versions.values()) list.sort((a, b) => a.timestamp - b.timestamp)

  return {
    groups: out,
    counts: { deliverables, intermediates, byKind },
    versions,
  }
}

/** 侧车元数据回填（异步读完再合并，避免台账构建依赖 IPC） */
export function applySidecarMeta(
  ledger: ArtifactLedger,
  metas: Readonly<Record<string, { kind?: ArtifactKind; title?: string; meta?: ArtifactMeta }>>,
): ArtifactLedger {
  if (Object.keys(metas).length === 0) return ledger

  const enrich = (artifact: Artifact): Artifact => {
    // 声明优先：工具已经说清楚 kind/title/meta 的，不让旧侧车覆盖
    if (artifact.declared) return artifact
    const sidecar = metas[artifact.path]
    if (!sidecar) return artifact
    return {
      ...artifact,
      ...(sidecar.kind ? { kind: sidecar.kind } : {}),
      ...(sidecar.title ? { title: sidecar.title } : {}),
      ...(sidecar.meta ? { meta: { ...artifact.meta, ...sidecar.meta } } : {}),
    }
  }

  const byKind: Partial<Record<ArtifactKind, number>> = {}
  let deliverables = 0
  let intermediates = 0
  const groups = ledger.groups.map((group) => {
    const nextDeliverables = group.deliverables.map(enrich)
    const nextIntermediates = group.intermediates.map(enrich)
    for (const item of nextDeliverables) {
      deliverables += 1
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    }
    for (const item of nextIntermediates) {
      intermediates += 1
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    }
    return { ...group, deliverables: nextDeliverables, intermediates: nextIntermediates }
  })

  return {
    groups,
    counts: { deliverables, intermediates, byKind },
    versions: ledger.versions,
  }
}
