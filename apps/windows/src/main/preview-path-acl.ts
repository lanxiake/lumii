/**
 * 文件预览路径 ACL：工作区 / 截图临时目录 / 录屏目录。
 * 供 files:read-preview-by-path 与 lumii-local 协议共用。
 */
import path from 'node:path'

/**
 * 判断绝对路径是否落在指定目录内（含目录本身）。
 */
export function isPathUnderDir(resolvedAbs: string, resolvedDir: string): boolean {
  const abs = path.resolve(resolvedAbs)
  const dir = path.resolve(resolvedDir)
  return abs === dir || abs.startsWith(dir + path.sep)
}

export interface PreviewPathAclDirs {
  /** Agent 当前工作区绝对路径 */
  workspaceCwd: string
  /** `{dataRoot}/recordings` */
  recordingsDir: string
  /** `{dataRoot}/temp/screenshots` */
  screenshotDir: string
}

/**
 * 预览路径是否在允许范围内。
 */
export function isAllowedPreviewPath(resolvedAbs: string, dirs: PreviewPathAclDirs): boolean {
  const abs = path.resolve(resolvedAbs)
  if (isPathUnderDir(abs, dirs.workspaceCwd)) return true
  if (isPathUnderDir(abs, dirs.recordingsDir)) return true
  if (isPathUnderDir(abs, dirs.screenshotDir)) return true
  return false
}
