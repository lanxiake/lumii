/**
 * Workspace VCS 类型定义
 *
 * 工作空间本地 Git 版本管理（基于 isomorphic-git）的共享类型。
 * 跨端友好：不含 Electron 专有概念，便于未来 macOS / 移动端复用。
 */

/** 单次提交（快照）的元信息 */
export interface VcsCommit {
  /** commit 哈希（oid） */
  readonly oid: string
  /** 提交说明 */
  readonly message: string
  /** 提交时间（毫秒时间戳） */
  readonly timestamp: number
  /** 提交来源：agent=每轮自动快照；user=用户手动保存/回滚备份 */
  readonly author: 'agent' | 'user'
  /** 关联的会话 ID（自动快照时写入，供未来「回溯对话联动回滚」） */
  readonly conversationId?: string
  /** 关联的运行 ID（自动快照时写入） */
  readonly runId?: string
  /** 相对父提交的变更文件数（log 时懒算，可选） */
  readonly filesChanged?: number
  /** 相对父提交的新增行数（可选） */
  readonly insertions?: number
  /** 相对父提交的删除行数（可选） */
  readonly deletions?: number
}

/** diff 中单个文件的变更状态 */
export type VcsFileStatus = 'added' | 'modified' | 'deleted'

/** 单个文件的逐行 diff hunk（与 diff 库 structuredPatch 对齐） */
export interface VcsDiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  /** 差异行，带 +/-/空格 前缀 */
  readonly lines: readonly string[]
}

/** 一个文件在两个版本间的差异 */
export interface VcsDiffEntry {
  readonly filepath: string
  readonly status: VcsFileStatus
  readonly insertions: number
  readonly deletions: number
  /** 逐行 hunks（按需加载；statusDiff 默认不带） */
  readonly hunks?: readonly VcsDiffHunk[]
  /** 内容过大时跳过逐行 diff */
  readonly truncated?: boolean
  /** 跳过逐行 diff 的原因说明 */
  readonly skipReason?: string
}

/** 回滚结果 */
export interface VcsRollbackResult {
  /** 回滚前自动备份的 commit oid（无变更时为 null） */
  readonly backupOid: string | null
  /** 已恢复到的目标 commit oid */
  readonly restoredOid: string
}

/** commit 入参 */
export interface VcsCommitOptions {
  readonly message: string
  readonly author: 'agent' | 'user'
  readonly conversationId?: string
  readonly runId?: string
}
