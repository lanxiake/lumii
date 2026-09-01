/**
 * Wiki 列表展示名：标题补上原文件后缀（.lumii-ref 侧车不算后缀）。
 */
const SIDECAR_EXT = /\.(url\.)?lumii-ref$/i

/**
 * 从路径取出真正的文件后缀；引用侧车本身的 .lumii-ref 忽略。
 */
export function originalFileExtension(filePath: string | null | undefined): string | null {
  if (!filePath || /^https?:\/\//i.test(filePath.trim())) return null
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const stripped = base.replace(SIDECAR_EXT, '')
  const dot = stripped.lastIndexOf('.')
  if (dot <= 0 || dot === stripped.length - 1) return null
  const ext = stripped.slice(dot)
  if (!/^\.[a-zA-Z0-9]{1,12}$/.test(ext)) return null
  return ext
}

/**
 * 列表标题带原文件后缀；标题里已有相同后缀则不重复。
 */
export function titleWithOriginalExt(title: string, originalPath: string | null | undefined): string {
  const ext = originalFileExtension(originalPath)
  if (!ext) return title
  if (title.toLowerCase().endsWith(ext.toLowerCase())) return title
  return `${title}${ext}`
}
