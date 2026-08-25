/**
 * Wiki 摄入用的纯文本读取（宿主侧实现，注入 WikiContentExtractor）
 *
 * 产物/上传摄入钩子只拿到路径、没有正文，不读文件就会归档出空页、检索不到。
 * 但这是自动触发的旁路，读取范围必须收窄：
 * - 只允许工作空间内的路径，越界一律拒（摄入路径来自工具参数，不能当可信输入）
 * - 只读扩展名白名单内的纯文本（二进制文档读出来是乱码，会污染索引）
 * - 超过 maxBytes 只取前缀，避免大日志撑爆提示词与索引
 */

import { createReadStream } from 'node:fs'
import path from 'node:path'
import { isTextReadablePath } from '@mtbot/agent-runtime'
import { resolveActiveWorkspaceDir } from '../workspace-paths'
import { createLogger } from '../logger'

const log = createLogger('wiki-text-reader')

/**
 * 把摄入路径解析成工作空间内的绝对路径。
 * @returns 绝对路径；越界或非文本类型返回 null
 */
export function resolveWikiReadablePath(filePath: string, workspaceRoot: string): string | null {
  if (!isTextReadablePath(filePath)) return null
  const root = path.resolve(workspaceRoot)
  const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath)
  const relative = path.relative(root, absolute)
  // 空串表示就是根目录本身；以 .. 开头或仍是绝对路径都说明逃出了工作空间
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return absolute
}

/**
 * 读取文件前 maxBytes 字节并按 UTF-8 解码。
 * 用流式读取而非 readFile，避免为了取前 200KB 把整个大文件读进内存。
 */
export async function readTextPrefix(absolutePath: string, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  const stream = createReadStream(absolutePath, { start: 0, end: maxBytes - 1 })
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    chunks.push(buf)
    total += buf.length
    if (total >= maxBytes) break
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8')
}

/**
 * 供 WikiContentExtractor 注入的读取实现。
 * 任何失败都返回 null——摄入是旁路，读不到只是正文留空，不能让主流程失败。
 */
export async function readWorkspaceTextForWiki(
  filePath: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const absolute = resolveWikiReadablePath(filePath, resolveActiveWorkspaceDir())
    if (!absolute) return null
    return await readTextPrefix(absolute, maxBytes)
  } catch (err) {
    log.warn(`[Wiki] 摄入读取文件失败（正文留空，条目仍归档）: ${(err as Error).message}`)
    return null
  }
}
