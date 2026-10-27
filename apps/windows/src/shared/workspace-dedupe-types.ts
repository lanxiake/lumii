/**
 * 中间产物内容去重（P2 T9）的跨进程契约
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §4.8
 *
 * 只处理**中间产物**、只手动触发、用硬链接（同卷）；被成品引用的文件跳过。
 * 路径不变、内容不变，用户手里的文件仍然能打开。
 */

export interface DedupeGroup {
  /** 内容的 sha256 */
  hash: string
  /** 单文件字节数 */
  size: number
  /** 保留的原文件（其余路径链接到它） */
  keep: string
  /** 将被替换成硬链接的重复路径 */
  duplicates: string[]
  /** 去重后共享同一内容的路径数（= fs.stat.nlink，用于 UI 显示引用计数） */
  links: number
}

export interface DedupeSkipped {
  path: string
  /** too-recent / too-small / referenced / symlink / not-intermediate */
  reason: string
}

export interface DedupePlan {
  groups: DedupeGroup[]
  /** 将被替换的重复文件数（duplicates 总数） */
  totalFiles: number
  /** 预计可回收字节（重复文件大小之和） */
  reclaimableBytes: number
  skipped: DedupeSkipped[]
  /** 扫描因预算截断，结果不完整 */
  truncated: boolean
}

export interface DedupePlanResult {
  ok: true
  plan: DedupePlan
}

export interface DedupeApplyResult {
  ok: true
  /** 成功改成硬链接的路径数 */
  linked: number
  freedBytes: number
  failed: DedupeSkipped[]
}

export interface DedupeFailure {
  ok: false
  error: string
}

/** 参与去重的最小体积与最短年龄（太小/太新不值得冒风险） */
export const DEDUPE_MIN_BYTES = 64 * 1024
export const DEDUPE_MIN_AGE_MS = 24 * 60 * 60 * 1000
