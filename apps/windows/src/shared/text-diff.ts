/**
 * 行级文本 diff（工作台 / VCS 共用）
 *
 * 基于 npm `diff` 的 structuredPatch；P2 的就地修改预览与 T3 的版本对照都用这一份，
 * 避免 VCS 插件与工作台各写一套。VCS 插件 `vcs-diff.ts` 已改为调用这里。
 */

import { structuredPatch } from 'diff'

/** 单文件参与行级 diff 的最大字节数（任一侧） */
export const MAX_DIFF_BYTES = 512_000

export interface TextDiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  /** 差异行，带 +/-/空格 前缀 */
  readonly lines: readonly string[]
}

export interface TextDiffResult {
  readonly insertions: number
  readonly deletions: number
  readonly hunks: readonly TextDiffHunk[]
}

export function diffText(
  oldContent: string,
  newContent: string,
  filepath = 'a',
  context = 3,
): TextDiffResult {
  const patch = structuredPatch(filepath, filepath, oldContent, newContent, undefined, undefined, {
    context,
  })

  let insertions = 0
  let deletions = 0
  const hunks: TextDiffHunk[] = []

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
      lines: h.lines.map((line) => '' + line),
    })
  }

  return { insertions, deletions, hunks }
}
