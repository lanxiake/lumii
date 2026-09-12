/**
 * 文件服务 — 封装 window.electronAPI.file 的通用文件操作
 *
 * 薄封装，不做状态管理；错误原样抛给调用方（各调用点保留原有 try/catch 提示）。
 */

/** 目录列举 / 搜索结果条目（主进程字段原样透传，日期经 IPC 结构化克隆可能为 Date 或字符串） */
export interface RawFileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: string | Date
  createdAt: string | Date
  extension?: string
}

export interface FileSearchOptions {
  recursive?: boolean
  maxResults?: number
  extensions?: readonly string[]
  skipDirs?: readonly string[]
}

/** 列举目录内容 */
export async function listDirectory(dirPath: string): Promise<RawFileEntry[]> {
  const raw = await window.electronAPI.file.list(dirPath)
  return raw as RawFileEntry[]
}

/** 按关键词 / 扩展名搜索文件 */
export async function searchFiles(
  dirPath: string,
  pattern: string,
  options?: FileSearchOptions,
): Promise<RawFileEntry[]> {
  const raw = await window.electronAPI.file.search(dirPath, pattern, options)
  return raw as RawFileEntry[]
}

/** 移动（重命名）文件或目录 */
export async function moveFile(sourcePath: string, destPath: string): Promise<void> {
  await window.electronAPI.file.move(sourcePath, destPath)
}

/** 删除文件或目录 */
export async function deleteFile(filePath: string): Promise<void> {
  await window.electronAPI.file.delete(filePath)
}

/** 写入文本文件（覆盖） */
export async function writeFile(filePath: string, content: string): Promise<void> {
  await window.electronAPI.file.write(filePath, content)
}

/** 创建目录 */
export async function createDirectory(dirPath: string): Promise<void> {
  await window.electronAPI.file.createDir(dirPath)
}
