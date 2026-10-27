/**
 * 清理审计的读取侧（设置页「最近清理」）。
 *
 * 审计是「一天一个 jsonl、只追加」：读最近的文件尾巴即可，不整目录扫。
 * 坏行直接跳过——审计读不动不该挡住清理本身。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface CleanupHistoryEntry {
  at: string
  action: 'trash' | 'skip' | string
  path?: string
  role?: string
  bytes?: number
  trashId?: string
  trigger?: string
  reason?: string
}

/** 读最近 `limit` 条记录（按文件时间倒序、文件内正序拼接后截尾） */
export async function readCleanupHistory(
  logDir: string,
  limit = 50,
): Promise<CleanupHistoryEntry[]> {
  let names: string[]
  try {
    names = (await fs.readdir(logDir)).filter((name) => /^cleanup-\d{8}\.jsonl$/.test(name)).sort()
  } catch {
    return []
  }
  // 从最新的文件往回读，凑够 limit 就停
  const picked: CleanupHistoryEntry[] = []
  for (let index = names.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const name = names[index]!
    let text: string
    try {
      text = await fs.readFile(path.join(logDir, name), 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    const entries: CleanupHistoryEntry[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as CleanupHistoryEntry
        if (parsed && typeof parsed.at === 'string' && typeof parsed.action === 'string') {
          entries.push(parsed)
        }
      } catch {
        // 坏行跳过
      }
    }
    // 文件内是追加顺序（旧→新）；从最新往回取，最后统一按时间倒序
    picked.push(...entries.slice(Math.max(0, entries.length - (limit - picked.length))))
  }
  picked.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return picked.slice(0, limit)
}
