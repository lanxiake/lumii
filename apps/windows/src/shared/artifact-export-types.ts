/**
 * 产物导出 / 批量删除的跨进程契约（main / preload / renderer 共用）
 */

export type ArtifactExportMode = 'zip' | 'copy' | 'save'

export interface ArtifactExportResult {
  ok: boolean
  /** 实际导出的文件数 */
  exported: number
  /** 源文件总字节（不是压缩后的体积） */
  bytes: number
  /** 用户选定的目标路径（取消时无） */
  destPath?: string
  error?: string
}

export interface ArtifactTrashResult {
  ok: boolean
  /** 移入回收站的条数 */
  removed: number
  bytes: number
  /** 被安全闸跳过（不是成品引用就是最近写入） */
  skipped: number
  trashId?: string
  error?: string
}
