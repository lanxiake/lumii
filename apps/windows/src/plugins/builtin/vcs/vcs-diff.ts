/**
 * Workspace VCS — 逐行 diff 计算
 *
 * 纯计算已抽到 `shared/text-diff.ts`（P2 工作台共用）；这里保留 VCS 的类型形状，
 * 避免现有调用方与测试大改。
 */

import { diffText, MAX_DIFF_BYTES } from '../../../shared/text-diff'
import type { VcsDiffHunk } from './types'

export { MAX_DIFF_BYTES }

/** 单文件 diff 结果 */
export interface FileDiffResult {
  readonly insertions: number
  readonly deletions: number
  readonly hunks: readonly VcsDiffHunk[]
}

/**
 * 计算两份文本内容的逐行差异。
 * @param filepath 文件路径（仅用于 patch header 标识）
 * @param oldContent 旧版本内容（不存在传空串）
 * @param newContent 新版本内容（不存在传空串）
 */
export function computeFileDiff(
  filepath: string,
  oldContent: string,
  newContent: string,
): FileDiffResult {
  return diffText(oldContent, newContent, filepath)
}

/**
 * 仅计算 ±统计（不保留 hunks），用于列表场景的轻量统计。
 */
export function computeDiffStats(
  oldContent: string,
  newContent: string,
): { insertions: number; deletions: number } {
  const result = diffText(oldContent, newContent, 'a', 0)
  return { insertions: result.insertions, deletions: result.deletions }
}
