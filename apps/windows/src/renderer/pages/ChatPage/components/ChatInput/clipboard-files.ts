/**
 * 从剪贴板取出文件。
 *
 * 截图工具（微信 / QQ / 系统截图）写入的是位图，Chromium 只在 `items` 里给出
 * kind='file' 的项，`files` 常常是空的 —— 只读 `files` 会让「粘贴截图」静默无效。
 */
interface ClipboardLike {
  files?: ArrayLike<File> | null
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null
}

export function collectClipboardFiles(clipboard: ClipboardLike | null | undefined): File[] {
  if (!clipboard) return []
  const files = Array.from(clipboard.files ?? [])
  if (files.length > 0) return files
  const result: File[] = []
  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) result.push(file)
  }
  return result
}
