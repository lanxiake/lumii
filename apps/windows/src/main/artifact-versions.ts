/**
 * 版本模型：把 `fileChanges`（turn）与本地编辑（local）合并成一条时间线（P2 T3）
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §4.3 / §4.4
 *
 * 内容来源：
 * - turn 文本：`.mtbot-vcs/turn-index.jsonl` → oid → VCS `readFileAt`；
 * - local：`.lumii/edits/<id>/candidate`；
 * - 媒体/Office 的 turn 版本没有内容副本（VCS 不含二进制），如实标不可取。
 *
 * 列表阶段只做「可用性推断」，不读 blob；真正读内容发生在 diff/预览时。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileChangeEntry } from '@mtbot/agent-runtime'
import type { LocalArtifactEdit } from '../shared/artifact-edit-types'
import type {
  ArtifactVersionInfo,
  VersionContentInfo,
} from '../shared/artifact-version-types'
import { isTextArtifactPath } from '../shared/artifact-rules'
import { parseTurnIndex, resolveTurnOid, type TurnIndexEntry } from '../shared/turn-index'
import { getLocalEditContent } from './artifact-edit'
import { getVcsService } from './agent-runtime/vcs-accessor'
import {
  hasTurnTextVersion,
  readTurnTextVersion,
} from './turn-version-store'

export interface TurnChangeRow {
  messageId: string
  timestamp: string
  changes: readonly FileChangeEntry[]
}

export function turnVersionId(messageId: string): string {
  return `turn:${messageId}`
}

export function localVersionId(editId: string): string {
  return `local:${editId}`
}

export function parseVersionId(
  versionId: string,
): { source: 'turn' | 'local'; id: string } | null {
  if (versionId.startsWith('turn:')) {
    const id = versionId.slice('turn:'.length)
    return id ? { source: 'turn', id } : null
  }
  if (versionId.startsWith('local:')) {
    const id = versionId.slice('local:'.length)
    return id ? { source: 'local', id } : null
  }
  return null
}

const indexCache = new Map<
  string,
  { mtimeMs: number; size: number; entries: TurnIndexEntry[] }
>()

/** 读 `<ws>/.mtbot-vcs/turn-index.jsonl`；按 mtime/size 缓存 */
export async function readTurnIndex(workspaceDir: string): Promise<TurnIndexEntry[]> {
  const file = path.join(workspaceDir, '.mtbot-vcs', 'turn-index.jsonl')
  try {
    const stat = await fs.stat(file)
    const cached = indexCache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.entries
    }
    const text = await fs.readFile(file, 'utf8')
    const entries = parseTurnIndex(text)
    indexCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries })
    return entries
  } catch {
    return []
  }
}

function turnContentInfo(
  relPath: string,
  messageId: string,
  timestamp: number,
  entries: readonly TurnIndexEntry[],
): VersionContentInfo {
  if (!isTextArtifactPath(relPath)) {
    return {
      available: false,
      reason: '该版本的原始文件未被保留（VCS 不含二进制）',
    }
  }
  const resolved = resolveTurnOid(entries, messageId, timestamp)
  if (!resolved) return { available: false, reason: '没有可用的文本快照' }
  return {
    available: true,
    kind: 'git',
    ...(resolved.approximate ? { approximate: true } : {}),
  }
}

export async function buildMergedVersions(opts: {
  workspaceDir: string
  path: string
  turns: readonly TurnChangeRow[]
  localEdits: readonly LocalArtifactEdit[]
}): Promise<ArtifactVersionInfo[]> {
  const entries = await readTurnIndex(opts.workspaceDir)
  const versions: ArtifactVersionInfo[] = []

  for (const turn of opts.turns) {
    const timestamp = Date.parse(turn.timestamp)
    if (!Number.isFinite(timestamp)) continue
    for (const change of turn.changes) {
      if (change.path !== opts.path) continue
      const stored =
        change.status !== 'deleted' &&
        (await hasTurnTextVersion({
          workspaceDir: opts.workspaceDir,
          messageId: turn.messageId,
          path: opts.path,
        }))
      versions.push({
        versionId: turnVersionId(turn.messageId),
        source: 'turn',
        turnId: turn.messageId,
        timestamp,
        status: change.status,
        content: stored
          ? { available: true, kind: 'store' }
          : turnContentInfo(opts.path, turn.messageId, timestamp, entries),
      })
    }
  }

  for (const edit of opts.localEdits) {
    if (edit.path !== opts.path) continue
    // 变体是**新文件**：该版本的内容就是工作区里的那个文件，编辑存储里没有副本
    if (edit.action === 'variant') {
      let exists = false
      try {
        const stat = await fs.stat(path.join(opts.workspaceDir, ...edit.path.split('/')))
        exists = stat.isFile()
      } catch {
        exists = false
      }
      versions.push({
        versionId: localVersionId(edit.editId),
        source: 'local',
        timestamp: edit.at,
        status: 'edited',
        content: exists
          ? { available: true, kind: 'store' }
          : { available: false, reason: '变体文件已不在工作区' },
      })
      continue
    }
    const store = await getLocalEditContent({
      workspaceDir: opts.workspaceDir,
      editId: edit.editId,
    })
    const content: VersionContentInfo =
      store && store.text !== null
        ? { available: true, kind: 'store' }
        : { available: false, reason: store ? '该版本不是文本文件' : '本地编辑内容已清理' }
    versions.push({
      versionId: localVersionId(edit.editId),
      source: 'local',
      timestamp: edit.at,
      status: 'edited',
      content,
    })
  }

  versions.sort(
    (a, b) => a.timestamp - b.timestamp || a.versionId.localeCompare(b.versionId),
  )

  // 删除版没有可读内容：用前一版内容展示，并标近似
  for (let index = 0; index < versions.length; index += 1) {
    const version = versions[index]!
    if (version.status !== 'deleted') continue
    const previous = versions[index - 1]
    if (previous?.content.available) {
      version.content = {
        available: true,
        ...(previous.content.kind ? { kind: previous.content.kind } : {}),
        approximate: true,
      }
    } else {
      version.content = { available: false, reason: '该版本已删除，且没有可用的前一版内容' }
    }
  }

  return versions
}

export interface ResolvedVersionContent {
  text: string
  kind: 'git' | 'store'
  approximate?: boolean
}

/**
 * 取某个版本的实际文本；不可取/非文本返回可读原因。
 * 删除版按前一版内容解析（递归一层）。
 */
export async function resolveVersionContent(opts: {
  workspaceDir: string
  path: string
  version: ArtifactVersionInfo
  allVersions: readonly ArtifactVersionInfo[]
}): Promise<{ ok: true; content: ResolvedVersionContent } | { ok: false; reason: string }> {
  const { version } = opts
  if (!isTextArtifactPath(opts.path)) {
    return { ok: false, reason: '该类型不支持文本 diff' }
  }

  if (version.status === 'deleted') {
    const index = opts.allVersions.findIndex((item) => item.versionId === version.versionId)
    const previous = index > 0 ? opts.allVersions[index - 1] : undefined
    if (!previous) return { ok: false, reason: '没有可用的前一版内容' }
    const resolved = await resolveVersionContent({
      workspaceDir: opts.workspaceDir,
      path: opts.path,
      version: previous,
      allVersions: opts.allVersions,
    })
    if (!resolved.ok) return resolved
    return { ok: true, content: { ...resolved.content, approximate: true } }
  }

  if (version.source === 'local') {
    const parsed = parseVersionId(version.versionId)
    if (!parsed || parsed.source !== 'local') return { ok: false, reason: '版本 id 非法' }
    const store = await getLocalEditContent({
      workspaceDir: opts.workspaceDir,
      editId: parsed.id,
    })
    if (!store) return { ok: false, reason: '本地编辑内容已清理' }
    if (store.text === null) return { ok: false, reason: '该版本不是文本文件' }
    return { ok: true, content: { text: store.text, kind: 'store' } }
  }

  if (!version.content.available) {
    return { ok: false, reason: version.content.reason ?? '该版本内容不可取' }
  }
  if (!version.turnId) return { ok: false, reason: '缺少回合信息' }

  // 优先用 agent:end 时复制的精确文本副本（不受 VCS 快照时序影响）
  const stored = await readTurnTextVersion({
    workspaceDir: opts.workspaceDir,
    messageId: version.turnId,
    path: opts.path,
  })
  if (stored !== null) {
    return { ok: true, content: { text: stored, kind: 'store' } }
  }

  const entries = await readTurnIndex(opts.workspaceDir)
  const resolved = resolveTurnOid(entries, version.turnId, version.timestamp)
  if (!resolved) return { ok: false, reason: '没有可用的文本快照' }

  const service = getVcsService()
  if (!service) return { ok: false, reason: 'VCS 已停用，无法读取历史版本' }
  try {
    const text = await service.readFileAt(opts.workspaceDir, resolved.oid, opts.path)
    if (text === null) return { ok: false, reason: '该快照里没有这个文件' }
    return {
      ok: true,
      content: {
        text,
        kind: 'git',
        ...(resolved.approximate ? { approximate: true } : {}),
      },
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : '读取历史版本失败' }
  }
}
