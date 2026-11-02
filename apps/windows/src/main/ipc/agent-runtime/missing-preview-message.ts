/**
 * 预览目标缺失时的可读错误文案。
 *
 * 产物台账会长期保留历史路径；视频下载器又可能 TTL 清盘或只留下 .part，
 * 笼统的「文件不存在或已被删除」看不出是哪条、是不是半成品。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 相对工作区的展示路径；越界时退回文件名。
 */
function displayPath(resolvedAbs: string, workspaceCwd?: string): string {
  if (workspaceCwd) {
    const rel = path.relative(path.resolve(workspaceCwd), path.resolve(resolvedAbs))
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.replace(/\\/g, '/')
    }
  }
  return path.basename(resolvedAbs)
}

/**
 * 同目录是否存在同 stem 的未完成下载（yt-dlp 的 `name.fXXXX.mp4.part` / `name.mp4.part`）。
 */
function hasIncompleteDownloadPart(resolvedAbs: string): boolean {
  const dir = path.dirname(resolvedAbs)
  const stem = path.basename(resolvedAbs, path.extname(resolvedAbs))
  if (!stem) return false
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return false
  }
  const prefix = `${stem}.`
  return entries.some(
    (name) =>
      name === `${stem}.part` ||
      (name.startsWith(prefix) && (name.endsWith('.part') || name.endsWith('.ytdl'))),
  )
}

/**
 * 构造预览缺失时的错误信息。
 */
export function describeMissingPreviewFile(resolvedAbs: string, workspaceCwd?: string): string {
  const shown = displayPath(resolvedAbs, workspaceCwd)
  if (hasIncompleteDownloadPart(resolvedAbs)) {
    return `下载未完成，成片尚未落盘：${shown}（目录里只有 .part，请重新下载）`
  }
  return `文件不存在或已被删除：${shown}`
}
