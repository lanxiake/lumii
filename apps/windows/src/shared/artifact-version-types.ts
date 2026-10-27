/**
 * 版本历史契约（P2 T3）
 *
 * `turn`：来自 assistant 消息的 fileChanges；文本内容从 VCS 快照读。
 * `local`：来自工作台编辑 / 手工保存；内容在 `.lumii/edits`。
 * `pin` 不是版本来源，而是版本上的固化标记（T6）。
 */

import type { TextDiffHunk } from './text-diff'

export type ArtifactVersionSource = 'turn' | 'local'

export type ArtifactVersionStatus = 'added' | 'modified' | 'deleted' | 'edited'

export interface VersionContentInfo {
  available: boolean
  kind?: 'git' | 'store'
  /** 快照合并/缺失索引时内容可能包含紧随其后的改动 */
  approximate?: boolean
  reason?: string
}

export interface ArtifactVersionInfo {
  /** turn:<messageId> | local:<editId> */
  versionId: string
  source: ArtifactVersionSource
  /** source=turn 时用于「回到消息」 */
  turnId?: string
  /** epoch ms */
  timestamp: number
  status: ArtifactVersionStatus
  content: VersionContentInfo
  /** 已固化（以此为准）；T6 写入 */
  pinned?: { pinId: string; at: number }
}

export interface ArtifactVersionDiffInput {
  sessionKey: string
  path: string
  fromVersionId: string
  toVersionId: string
}

export interface ArtifactVersionContentInput {
  sessionKey: string
  path: string
  versionId: string
}

export interface ArtifactVersionDiffOk {
  ok: true
  insertions: number
  deletions: number
  hunks: readonly TextDiffHunk[]
  truncated?: boolean
}

export type ArtifactVersionDiffResult =
  | ArtifactVersionDiffOk
  | { ok: false; reason: string }

export type ArtifactVersionContentResult =
  | { ok: true; text: string; approximate?: boolean }
  | { ok: false; reason: string }
