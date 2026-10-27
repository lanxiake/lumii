/**
 * 产物就地修改的跨进程契约（P2）
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §4.1 / §4.2
 * - 候选稿先落 `.lumii/edits/<editId>/`，用户确认后才原子替换目标文件；
 * - `baseHash` 是应用时的冲突闸（文件在预览期间被改过就拒绝）；
 * - 渲染层只拿 editId / candidate 路径，不把整份内容塞进 IPC 返回值。
 */

import type { TextDiffResult } from './text-diff'

export type ArtifactEditScope =
  /** UTF-16 偏移，基于 propose 时的磁盘内容 */
  | { type: 'text-range'; start: number; end: number }
  /** PPT 页码（0-based） */
  | { type: 'slide'; index: number }
  /** 图片同源变体（不经过候选稿） */
  | { type: 'image-variant' }

export type ArtifactEditAction =
  | 'manual'
  | 'rewrite'
  | 'expand'
  | 'shorten'
  | 'tone'
  | 'slide-title'
  | 'slide-bullets'
  | 'variant'
  | 'undo'

/** 文档选区的四种改写动作 */
export type DocumentEditAction = 'rewrite' | 'expand' | 'shorten' | 'tone'
export type EditTone = 'formal' | 'casual' | 'confident'

export interface ArtifactEditFailure {
  ok: false
  error: string
  code?: 'invalid-path' | 'invalid-scope' | 'conflict' | 'not-found' | 'unavailable' | 'cancelled'
}

export interface ArtifactEditProposal {
  ok: true
  editId: string
  /** 工作区相对路径：`.lumii/edits/<editId>/candidate.<ext>` */
  candidatePath: string
  changedScope: ArtifactEditScope
  /** 磁盘内容 sha256（文本由主进程计算；PPT 可省略入参） */
  baseHash: string
  beforeBytes: number
  afterBytes: number
  /** 文本类：候选与原内容的行级 diff（T2 提案面板用） */
  diff?: TextDiffResult
}

export interface ArtifactEditApplyResult {
  ok: true
  editId: string
  /** `local:<editId>`，供版本历史合并 */
  versionId: string
  appliedAt: number
  /** 工作区相对路径：改前副本 */
  backupPath: string
  /** 文件已写入但索引/登记失败时的可读提示（不当成应用失败） */
  warning?: string
}

export interface ArtifactEditUndoResult extends ArtifactEditApplyResult {
  /** 撤销本身也是一次本地编辑 */
  sourceEditId: string
}

/** 已应用的本地编辑（rail 合并 / 版本列表用） */
export interface LocalArtifactEdit {
  editId: string
  sessionKey: string | null
  path: string
  action: ArtifactEditAction
  scope: ArtifactEditScope
  at: number
  bytes: number
  /** 变体等派生文件：来源路径 */
  derivedFrom?: string
}

export interface ArtifactEditListResult {
  ok: true
  edits: LocalArtifactEdit[]
}

export interface ProposeTextEditInput {
  sessionKey?: string | null
  path: string
  start: number
  end: number
  replacement: string
  action?: ArtifactEditAction
  instruction?: string
  /** 渲染层按磁盘内容算的 sha256；主进程会再算一遍，不一致直接拒 */
  baseHash?: string
  /** 渲染层 requestId；缺省由主进程生成 */
  editId?: string
}

/** 文档选区改写（走单轮 LLM）的输入 */
export interface ProposeTextRangeInput {
  /** 渲染层生成的 requestId，同时用于取消 */
  editId: string
  sessionKey?: string | null
  path: string
  start: number
  end: number
  action: DocumentEditAction
  tone?: EditTone
  instruction?: string
  /** 渲染层按加载内容算的 sha256；主进程按磁盘再算一遍 */
  baseHash?: string
}
