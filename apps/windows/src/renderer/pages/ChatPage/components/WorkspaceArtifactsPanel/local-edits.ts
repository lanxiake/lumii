/**
 * 把「本地修改」（工作台编辑 / 手工保存）合并进 Agent 台账（P2 T1）
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §五 T1
 *
 * - 已存在的路径：只更新卡片时间与来源，不新增卡片；
 * - 只存在于本地编辑的新路径：建卡，归到 `artifactGroupKey(path)`；没有对应
 *   Agent 回合时建一个「本地修改」组；
 * - 不伪造消息、不改变 `turnId`（本地卡 `turnId` 为空，没有「回到消息」）。
 */

import type { LocalArtifactEdit } from '../../../../../shared/artifact-edit-types'
import {
  INTERMEDIATE_FOLD_THRESHOLD,
  classifyArtifact,
  kindOf,
} from '../../../../../shared/artifact-rules'
import {
  artifactGroupKey,
  type Artifact,
  type ArtifactGroup,
  type ArtifactLedger,
} from './ledger'

const LOCAL_GROUP_LABEL = '本地修改'

/**
 * 媒体判定：重命名/左右切换只在「能预览出画面/声音」的文件里走。
 * 与 FilePreviewModal 的 image/audio/video 三种路由对齐。
 */
const MEDIA_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg',
  'mp4', 'webm', 'mov', 'avi', 'm4v', 'ogv', 'mkv',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus',
])

export function isMediaPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MEDIA_EXTENSIONS.has(ext)
}

/**
 * 路径改名：工作区相对路径换掉最后一段。
 * 只接受「纯文件名」的新名字——带分隔符的输入是重命名到别的目录，不是这个入口该干的事。
 */
export function renamePath(path: string, newName: string): string | null {
  const trimmed = newName.trim()
  if (!trimmed || /[\\/]/.test(trimmed)) return null
  const at = path.lastIndexOf('/')
  return at < 0 ? trimmed : `${path.slice(0, at + 1)}${trimmed}`
}

/** 台账里出现的全部路径 → { 路径, 是否媒体 }（重命名后同步选中态用） */
export function artifactPaths(ledger: ArtifactLedger): string[] {
  const out = new Set<string>()
  for (const group of ledger.groups) {
    for (const item of group.deliverables) out.add(item.path)
    for (const item of group.intermediates) out.add(item.path)
  }
  return [...out]
}

/**
 * 把磁盘改名映射应用到台账上（旧路径 → 新路径）。
 *
 * 台账是从消息的 fileChanges 派生的，改名不会改历史消息，所以不改这里的话
 * 卡片会继续指着旧路径（缩略图变「文件已不在磁盘」），而新名字不出现。
 *
 * 只在本次会话内有效，与删除后的 `trashedPaths` 同一口径——目录改名/删除
 * 本来就不进历史，重启后回到「按历史记录展示」。
 */
export function applyPathRenames(
  ledger: ArtifactLedger,
  renames: ReadonlyMap<string, string>,
): ArtifactLedger {
  if (renames.size === 0) return ledger
  const rename = (item: Artifact): Artifact =>
    renames.has(item.path) ? { ...item, path: renames.get(item.path)! } : item

  let deliverables = 0
  let intermediates = 0
  const byKind: Partial<Record<Artifact['kind'], number>> = {}
  const groups: ArtifactGroup[] = []

  for (const group of ledger.groups) {
    // 改名可能把两条旧卡并到同一路径（例如改了名又改回来），按路径去重
    const dedupe = (items: readonly Artifact[]): Artifact[] => {
      const seen = new Map<string, Artifact>()
      for (const item of items) {
        const renamed = rename(item)
        if (!seen.has(renamed.path)) seen.set(renamed.path, renamed)
      }
      return [...seen.values()]
    }
    const next: ArtifactGroup = {
      ...group,
      deliverables: dedupe(group.deliverables),
      intermediates: dedupe(group.intermediates),
    }
    if (next.deliverables.length + next.intermediates.length === 0) continue
    for (const item of next.deliverables) {
      deliverables += 1
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    }
    for (const item of next.intermediates) {
      intermediates += 1
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    }
    groups.push(next)
  }

  return {
    groups,
    counts: { deliverables, intermediates, byKind },
    versions: new Map(ledger.versions),
  }
}

export function mergeLocalEdits(
  ledger: ArtifactLedger,
  edits: readonly LocalArtifactEdit[],
): ArtifactLedger {
  if (edits.length === 0) return ledger

  // 同一路径只取最新一条：卡片只关心「最近一次本地修改」
  const latest = new Map<string, LocalArtifactEdit>()
  for (const edit of edits) {
    const previous = latest.get(edit.path)
    if (!previous || edit.at >= previous.at) latest.set(edit.path, edit)
  }

  interface Slot {
    group: ArtifactGroup
    items: Map<string, Artifact>
  }

  const slots = new Map<string, Slot>()
  for (const group of ledger.groups) {
    const items = new Map<string, Artifact>()
    for (const item of [...group.deliverables, ...group.intermediates]) {
      items.set(item.path, { ...item })
    }
    slots.set(group.key, {
      group: { ...group, deliverables: [], intermediates: [] },
      items,
    })
  }

  for (const edit of latest.values()) {
    const role = classifyArtifact({ path: edit.path })
    if (role === 'internal' || role === 'ephemeral') continue

    const key = artifactGroupKey(edit.path)
    let slot = slots.get(key)
    if (!slot) {
      slot = {
        group: {
          key,
          label: LOCAL_GROUP_LABEL,
          timestamp: edit.at,
          startedAt: edit.at,
          deliverables: [],
          intermediates: [],
        },
        items: new Map(),
      }
      slots.set(key, slot)
    }

    const existing = slot.items.get(edit.path)
    if (existing) {
      // 只有本地编辑更晚才改来源/状态：之后的 Agent 回合写过，就以 Agent 为准
      if (edit.at >= existing.timestamp) {
        existing.timestamp = edit.at
        existing.origin = 'local'
        // 先被删后由本地编辑重建：状态回到 modified，避免卡片仍显示「已删除」
        if (existing.status === 'deleted') existing.status = 'modified'
        if (edit.derivedFrom) existing.derivedFrom = edit.derivedFrom
      }
    } else {
      slot.items.set(edit.path, {
        path: edit.path,
        kind: kindOf(edit.path),
        role: role === 'intermediate' ? 'intermediate' : 'deliverable',
        status: 'modified',
        timestamp: edit.at,
        turnId: '',
        origin: 'local',
        ...(edit.derivedFrom ? { derivedFrom: edit.derivedFrom } : {}),
      })
    }
    if (edit.at > slot.group.timestamp) slot.group.timestamp = edit.at
    if (edit.at < slot.group.startedAt) slot.group.startedAt = edit.at
  }

  const byKind: Partial<Record<Artifact['kind'], number>> = {}
  let deliverables = 0
  let intermediates = 0
  const groups: ArtifactGroup[] = []

  for (const slot of slots.values()) {
    const items = [...slot.items.values()].sort((a, b) => a.path.localeCompare(b.path))
    const intermediateItems = items.filter((item) => item.role === 'intermediate')
    const fold = intermediateItems.length >= INTERMEDIATE_FOLD_THRESHOLD
    const group: ArtifactGroup = {
      ...slot.group,
      deliverables: fold ? items.filter((item) => item.role === 'deliverable') : items,
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
    groups.push(group)
  }

  groups.sort((a, b) => b.timestamp - a.timestamp)

  return {
    groups,
    counts: { deliverables, intermediates, byKind },
    versions: new Map(ledger.versions),
  }
}
