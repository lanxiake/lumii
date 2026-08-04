/**
 * Workspace VCS — 逐行 diff 计算
 *
 * 基于 npm `diff` 库的 structuredPatch，将两个版本的文件内容转为
 * 行级 hunks 与 ±统计。isomorphic-git 本身不提供行级 diff，故在此独立实现。
 */

import { structuredPatch } from 'diff'
import type { VcsDiffHunk } from './types'

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
  const patch = structuredPatch(
    filepath,
    filepath,
    oldContent,
    newContent,
    undefined,
    undefined,
    { context: 3 },
  )

  let insertions = 0
  let deletions = 0
  const hunks: VcsDiffHunk[] = []

  for (const h of patch.hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) insertions++
      else if (line.startsWith('-')) deletions++
    }
    hunks.push({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      // 强制扁平字符串副本，避免 V8 sliced string 持有大父串引用
      lines: h.lines.map((l) => '' + l),
    })
  }

  return { insertions, deletions, hunks }
}

/**
 * 仅计算 ±统计（不保留 hunks），用于列表场景的轻量统计。
 */
export function computeDiffStats(
  oldContent: string,
  newContent: string,
): { insertions: number; deletions: number } {
  const patch = structuredPatch('a', 'a', oldContent, newContent, undefined, undefined, {
    context: 0,
  })
  let insertions = 0
  let deletions = 0
  for (const h of patch.hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) insertions++
      else if (line.startsWith('-')) deletions++
    }
  }
  return { insertions, deletions }
}
