/**
 * 工作区清理的跨进程契约（main / preload / renderer 共用）。
 */

export type CleanupRole = 'intermediate' | 'ephemeral'

export interface CleanupClassStats {
  count: number
  bytes: number
}

export interface CleanupCandidate {
  /** 工作区相对路径 */
  path: string
  role: CleanupRole
  bytes: number
  mtimeMs: number
}

export type CleanupSkipReason = 'too-recent' | 'referenced' | 'outside' | 'symlink' | 'locked'

export interface CleanupSkipped {
  path: string
  reason: CleanupSkipReason
}

export interface CleanupScan {
  workspaceDir: string
  classes: Record<'deliverable' | 'intermediate' | 'ephemeral' | 'internal', CleanupClassStats>
  /** 体积最大的前 20 个候选（真正删除前会重新全量校验） */
  candidates: CleanupCandidate[]
  skipped: CleanupSkipped[]
  /** 达到时间预算，统计不完整 */
  truncated: boolean
  scannedAt: number
}

export interface CleanupRunResult {
  ok: boolean
  dryRun: boolean
  removed: number
  bytes: number
  skipped: number
  trashId?: string
  error?: string
}

export interface CleanupTrashEntry {
  id: string
  createdAt: number
  bytes: number
  files: number
}

export interface CleanupRestoreResult {
  ok: boolean
  restored: number
  conflicts: number
  error?: string
}

export type CleanupScanResponse =
  | { ok: true; scan: CleanupScan }
  | { ok: false; error: string }
