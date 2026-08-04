/**
 * 本地文件操作 — ToolExecutionContext 的 file/glob/grep 实现
 */

import fs from 'fs/promises'
import path from 'path'

/**
 * 读取文件内容
 */
export async function readLocalFile(
  filePath: string,
  opts?: { offset?: number; limit?: number },
): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8')
  if (!opts?.offset && !opts?.limit) return content

  const lines = content.split('\n')
  const start = (opts?.offset ?? 1) - 1 // 1-based to 0-based
  const end = opts?.limit ? start + opts.limit : lines.length
  return lines.slice(Math.max(0, start), end).join('\n')
}

/**
 * 写入文件内容
 */
export async function writeLocalFile(filePath: string, content: string): Promise<void> {
  // 确保父目录存在
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

/**
 * 文件模式匹配查找
 *
 * 使用 Node.js 22+ 内建的 fs.glob。
 */
export async function globLocal(
  pattern: string,
  opts?: { cwd?: string },
): Promise<string[]> {
  const cwd = opts?.cwd ?? process.cwd()
  const results: string[] = []
  /** Node 22+ fs.promises.glob；在部分 TS/bundler 组合下需放宽类型 */
  const globFn = (fs as unknown as {
    glob: (p: string, o?: { cwd?: string }) => AsyncIterable<string>
  }).glob
  for await (const entry of globFn(pattern, { cwd })) {
    results.push(entry)
    if (results.length >= 1000) break // 限制结果数量
  }
  return results
}

/**
 * 内容搜索（简化版 grep）
 */
export async function grepLocal(
  pattern: string,
  opts?: { path?: string; glob?: string; maxResults?: number },
): Promise<Array<{ file: string; line: number; content: string }>> {
  const searchPath = opts?.path ?? process.cwd()
  const maxResults = opts?.maxResults ?? 100
  const results: Array<{ file: string; line: number; content: string }> = []

  const regex = new RegExp(pattern, 'g')

  // 获取要搜索的文件列表
  let files: string[] = []
  try {
    const stat = await fs.stat(searchPath)
    if (stat.isFile()) {
      files = [searchPath]
    } else {
      // 搜索目录下的文件
      const globPattern = opts?.glob ?? '**/*'
      const matches = await globLocal(globPattern, { cwd: searchPath })
      files = matches.map((f) => path.resolve(searchPath, f))
    }
  } catch {
    return results
  }

  for (const file of files) {
    if (results.length >= maxResults) break
    try {
      const content = await fs.readFile(file, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break
        if (regex.test(lines[i]!)) {
          results.push({ file, line: i + 1, content: lines[i]! })
        }
        regex.lastIndex = 0
      }
    } catch {
      // 跳过二进制文件或无法读取的文件
    }
  }

  return results
}
