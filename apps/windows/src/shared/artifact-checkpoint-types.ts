/**
 * 「恢复到这一轮」checkpoint（P2 T7）的跨进程契约
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §4.6
 *
 * 只恢复**本会话记录的工作区文件**：不恢复配置、依赖、环境变量与数据库；
 * 对话用 fork 分支，原会话保留。
 */

import type { ArtifactEditFailure } from './artifact-edit-types'

export type CheckpointFileAction = 'restore' | 'trash' | 'skip'

export interface CheckpointFilePlan {
  /** 工作区相对路径 */
  path: string
  action: CheckpointFileAction
  /** skip 的可读原因；restore 时说明来源 */
  reason?: string
  /** restore 的内容来源 */
  content?: 'git' | 'store' | 'pin'
  /** 锚点后第一次出现时的状态（added ⇒ 锚点时不存在） */
  firstStatus?: 'added' | 'modified' | 'deleted' | 'edited'
  /** 锚点后最近一次状态 */
  lastStatus?: 'added' | 'modified' | 'deleted' | 'edited'
  binary?: boolean
  /** content='store' 时：用这次本地编辑的 before 恢复 */
  editId?: string
  /** content='store' 时：用该轮 agent:end 的精确文本副本恢复（VCS 快照可能早于写入） */
  storeMessageId?: string
  /** content='pin' 时：用这个固化副本恢复 */
  pinId?: string
}

export interface CheckpointPlan {
  anchor: { turnId: string; timestamp: number }
  files: CheckpointFilePlan[]
  /** 锚点及之前最近一个非空快照；null = 没有可用的文本快照 */
  textCommitOid: string | null
  /** 快照经过合并时，内容可能包含锚点之后的改动 */
  approximate?: boolean
  canRestoreConversation: boolean
  /** 共用工作区等提示 */
  warnings?: string[]
}

export type CheckpointPlanResult =
  | { ok: true; plan: CheckpointPlan }
  | ArtifactEditFailure

export interface CheckpointApplyInput {
  sessionKey: string
  turnId: string
  /** 同时从此轮分支对话（默认 true） */
  restoreConversation: boolean
}

export interface CheckpointApplyResult {
  ok: true
  checkpointId: string
  restored: number
  trashed: number
  skipped: number
  backupOid: string | null
  /** 分支出的新会话；渲染层据此切换 */
  newSessionKey?: string
  /** 逐条未恢复原因（回收站被引用跳过、文本回退失败等） */
  warnings?: string[]
}

export interface CheckpointUndoResult {
  ok: true
  restored: number
  restoredFromTrash: number
  warnings?: string[]
}

export interface CheckpointAuditEntry {
  checkpointId: string
  sessionKey: string
  turnId: string
  at: number
  status: 'applying' | 'done' | 'undone' | 'failed'
  backupOid: string | null
  /** trashPaths 的批次 id；撤销时按批次整批放回 */
  trashBatchIds?: string[]
  restoredPaths?: string[]
  trashedPaths?: string[]
  skipped?: { path: string; reason: string }[]
  newSessionKey?: string
  error?: string
}
