/**
 * 文件枚举 — `readdir` 递归 + 跳过规则 + 批量回调。
 *
 * 设计：`docs/design/逆向与复刻/2026-11-14-Listary复刻启动器插件设计.md` §6.1
 *
 * 与 Listary 的差距如实记录：Listary 直读 NTFS `$MFT` 枚举全盘（秒级），
 * 这里走 `readdir` 递归（首扫分钟级）。这是本复刻最大的性能让步，不做掩饰。
 *
 * 两个性能要点：
 * 1. **单遍 `readdir(withFileTypes)` 拿 `Dirent` 类型**，不逐文件 `stat`。`stat` 是
 *    逐文件系统调用，能省则省；只在确实需要 size/mtime 时才 `statSync`。
 * 2. **批量回调**，不把整个文件系统堆成一个数组。
 */

import fs from 'node:fs'
import path from 'node:path'

import type { IndexItem, ItemKind } from './db.js'

/** 默认跳过的目录名（小写比较）。这些目录条目数巨大而检索价值极低。 */
export const DEFAULT_SKIP_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '$recycle.bin',
  'system volume information',
  'appdata',
  'windows',
  'winsxs',
  'installer',
  'programdata',
  'temp',
  'tmp',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
]

/**
 * 跳过判定。
 *
 * 只看**目录名**（不含路径），因为 `Windows\WinSxS` 这类是靠父目录层级定位的，
 * 单纯名字匹配会把用户自己的 `E:\my-project\build` 也误伤 —— 但两者都该跳，
 * 所以按名字跳是符合意图的。若将来要保留用户的 build 目录，改成路径规则。
 */
export function shouldSkipDir(name: string, skip: ReadonlySet<string>): boolean {
  return skip.has(name.toLowerCase())
}

export interface ScanOptions {
  roots: string[]
  /** 额外/覆盖的跳过目录名（小写） */
  skipDirs?: readonly string[]
  /** 最大深度，默认 12。够深，又不是无底洞。 */
  maxDepth?: number
  /** 每攒够多少条回调一次，默认 2000 */
  batchSize?: number
  onBatch: (items: IndexItem[]) => void
  /** 进度回调（可选） */
  onProgress?: (scanned: number) => void
  signal?: AbortSignal
}

export interface ScanResult {
  /** 计入索引的条目数 */
  indexed: number
  /** 跳过的目录数 */
  skippedDirs: number
  /** 读不了的目录数（权限等） */
  failedDirs: number
  /** 耗时 ms */
  durationMs: number
  /** 是否被 abort */
  aborted: boolean
}

/** 由文件名与类型推断条目类型 */
function classify(name: string, isDir: boolean): ItemKind {
  if (isDir) return 'dir'
  const ext = path.extname(name).toLowerCase()
  if (ext === '.lnk' || ext === '.url') return 'lnk'
  if (ext === '.exe' || ext === '.bat' || ext === '.cmd' || ext === '.com' || ext === '.msi') return 'app'
  return 'file'
}

/** 规范化路径：统一反斜杠、盘符小写。用于去重与跨来源合并。 */
export function normalizePath(p: string): string {
  const s = p.replace(/\//g, '\\')
  return /^[a-z]:/i.test(s) ? s[0].toLowerCase() + s.slice(1) : s
}

/**
 * 递归扫描。
 *
 * 不看 `size`/`mtime` —— 那要为每个文件多一次 `stat`，是首扫耗时的主要来源。
 * 需要展示这些字段时再按需 `stat`（P3 的结果列表里做）。
 */
export function scanSync(options: ScanOptions): ScanResult {
  const skip = new Set((options.skipDirs ?? DEFAULT_SKIP_DIRS).map((s) => s.toLowerCase()))
  const maxDepth = options.maxDepth ?? 12
  const batchSize = options.batchSize ?? 2000

  const started = Date.now()
  let indexed = 0
  let skippedDirs = 0
  let failedDirs = 0
  let aborted = false
  let batch: IndexItem[] = []

  const flush = (): void => {
    if (batch.length === 0) return
    options.onBatch(batch)
    batch = []
  }

  const walk = (dir: string, root: string, depth: number): void => {
    if (aborted) return
    if (options.signal?.aborted) {
      aborted = true
      return
    }
    if (depth > maxDepth) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      // 权限、竞态删除等。**不中断整次扫描** —— 一个目录读不了不该让全盘索引失败。
      failedDirs++
      return
    }

    for (const entry of entries) {
      if (aborted) return
      const isDir = entry.isDirectory()
      const isFile = entry.isFile()

      // 符号链接/其它类型（socket、fifo）跳过：跟着链接可能成环，也几乎无检索价值
      if (!isDir && !isFile) continue

      const full = path.join(dir, entry.name)

      if (isDir) {
        if (shouldSkipDir(entry.name, skip)) {
          skippedDirs++
          continue
        }
        batch.push({
          path: normalizePath(full),
          name: entry.name,
          ext: null,
          kind: 'dir',
          size: null,
          mtime: null,
          root,
          isStart: false,
        })
        indexed++
        if (batch.length >= batchSize) flush()
        walk(full, root, depth + 1)
      } else {
        batch.push({
          path: normalizePath(full),
          name: entry.name,
          ext: path.extname(entry.name).toLowerCase() || null,
          kind: classify(entry.name, false),
          size: null,
          mtime: null,
          root,
          isStart: false,
        })
        indexed++
        if (batch.length >= batchSize) flush()
      }
      if (indexed % 5000 === 0) options.onProgress?.(indexed)
    }
  }

  for (const root of options.roots) {
    if (aborted) break
    const normRoot = normalizePath(root)
    if (!fs.existsSync(root)) {
      failedDirs++
      continue
    }
    // 根目录自身也作为一条条目（用户会搜目录名）
    try {
      const st = fs.statSync(root)
      batch.push({
        path: normRoot,
        name: path.basename(root),
        ext: null,
        kind: 'dir',
        size: null,
        mtime: st.mtimeMs,
        root: normRoot,
        isStart: false,
      })
      indexed++
    } catch {
      failedDirs++
    }
    walk(root, normRoot, 1)
  }

  flush()
  return { indexed, skippedDirs, failedDirs, durationMs: Date.now() - started, aborted }
}
