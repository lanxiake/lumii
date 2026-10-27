/**
 * 「全部」作用域：把 `files:list` 的登记记录映射成 rail 能用的产物条目。
 *
 * 只包含**已登记**的文件（`client_files`）——真正的工作区可能还有大量没被任何
 * 回合写过的文件，那部分只有「工作区文件」视图看得到，界面上必须说清楚。
 * 工作区外的路径（数据根、别的磁盘）直接丢掉：点开也预览不了。
 */

import { kindOf, type ArtifactKind } from '../../../../../shared/artifact-rules'

export interface AllFileRow {
  readonly fileName?: string
  readonly localPath: string
  readonly fileSize?: number | null
  readonly createdAt?: string
  readonly conversationId?: string | null
  readonly category?: string
}

export interface AllArtifact {
  /** 工作区相对路径（posix） */
  path: string
  kind: ArtifactKind
  fileName: string
  size?: number
  createdAt: number
  conversationId?: string
  /** 登记来源（output=产物，upload=上传） */
  category?: string
}

/** 绝对路径 → 工作区相对路径；不在工作区内返回 null */
export function relativeToWorkspace(
  localPath: string,
  workspaceDir: string | undefined,
): string | null {
  if (!localPath) return null
  const normalized = localPath.replace(/\\/g, '/')
  const isAbsolute = normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)
  // client_files 里两种口径都存在：老记录存工作区相对路径，新记录存绝对路径
  if (!isAbsolute) return normalized.replace(/^\.\//, '') || null
  if (!workspaceDir) return null
  const root = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const lower = normalized.toLowerCase()
  const rootLower = root.toLowerCase()
  if (lower === rootLower) return null
  if (!lower.startsWith(`${rootLower}/`)) return null
  return normalized.slice(root.length + 1)
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 映射并过滤：缺失目录信息/工作区外/无本地路径的行都不要 */
export function mapAllFiles(
  rows: readonly AllFileRow[],
  workspaceDir: string | undefined,
): AllArtifact[] {
  const out: AllArtifact[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row.localPath !== 'string') continue
    const relative = relativeToWorkspace(row.localPath, workspaceDir)
    if (!relative) continue
    if (seen.has(relative)) continue
    seen.add(relative)
    const createdAt = parseTime(row.createdAt) ?? 0
    const fileName = row.fileName?.trim() || relative.split('/').pop() || relative
    out.push({
      path: relative,
      kind: kindOf(relative),
      fileName,
      ...(typeof row.fileSize === 'number' && row.fileSize > 0 ? { size: row.fileSize } : {}),
      createdAt,
      ...(row.conversationId ? { conversationId: row.conversationId } : {}),
      ...(row.category ? { category: row.category } : {}),
    })
  }
  // 新的在前（跨会话按时间倒序，和 files:list 的口径一致）
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}
