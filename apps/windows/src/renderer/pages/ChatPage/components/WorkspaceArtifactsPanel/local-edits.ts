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
