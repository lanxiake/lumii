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
  pinned?: { pinId: string; at: number; bytes?: number }
}

export interface ArtifactVersionDiffInput {
  sessionKey: string
  path: string
  fromVersionId: string
  toVersionId: string
  /** 展示用标签（如「本地 17:03」）；图片/PPT 对照面板据此标注两侧 */
  fromLabel?: string
  toLabel?: string
}

export interface ArtifactVersionContentInput {
  sessionKey: string
  path: string
  versionId: string
}

export interface ArtifactVersionDiffOk {
  ok: true
  /** 文本/代码：逐行 diff */
  kind: 'text'
  insertions: number
  deletions: number
  hunks: readonly TextDiffHunk[]
  truncated?: boolean
}

/** 图片两版都有内容：并排看（物化副本的工作区相对路径） */
export interface ArtifactVersionImageCompareOk {
  ok: true
  kind: 'image'
  from: { path: string; label: string }
  to: { path: string; label: string }
}

/** PPT 页级文本对照：只列有变化的页 */
export interface SlideVersionDiff {
  /** 0-based 页码 */
  index: number
  /** 该页标题（目标版优先） */
  title: string
  insertions: number
  deletions: number
  hunks: readonly TextDiffHunk[]
}

export interface ArtifactVersionSlidesCompareOk {
  ok: true
  kind: 'slides'
  fromLabel: string
  toLabel: string
  pages: readonly SlideVersionDiff[]
  totalPages: number
}

export type ArtifactVersionDiffResult =
  | ArtifactVersionDiffOk
  | ArtifactVersionImageCompareOk
  | ArtifactVersionSlidesCompareOk
  | { ok: false; reason: string }

export type ArtifactVersionContentResult =
  | { ok: true; text: string; approximate?: boolean }
  | { ok: false; reason: string }
