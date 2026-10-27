/**
 * 回合文本版本副本（P2 T3）
 *
 * 为什么需要它：VCS 自动快照在工具循环里可能早于本轮最后一次 file_write，
 * 且快照队列是纯 promise 链、可能被前一个任务堵住；只靠 git 会拿到「回合
 * 中途」的文本。这里在 `agent:end`（工具全部结束、fileChanges 已算好）把
 * 本轮改动的**成品文本**复制一份，作为精确版本内容；VCS 仍作为回退。
 *
 * 只存成品（deliverable）+ 文本，单文件 ≤10MB、每回合 ≤50 个；不做二进制。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { classifyArtifact, isTextArtifactPath } from '../shared/artifact-rules'

const VERSIONS_DIR = '.lumii/versions'
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_FILES_PER_TURN = 50
const DEFAULT_MAX_AGE_DAYS = 30
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function safeTurnId(messageId: string): string | null {
  return /^[A-Za-z0-9_-]{6,80}$/.test(messageId) ? messageId : null
}

function turnDir(root: string, messageId: string): string {
  return path.join(root, ...VERSIONS_DIR.split('/'), `turn-${messageId}`)
}

function destFor(root: string, messageId: string, rel: string): string {
  return path.join(turnDir(root, messageId), ...rel.split('/'))
}

async function resolveRoot(workspaceDir: string): Promise<string | null> {
  try {
    return await fs.realpath(path.resolve(workspaceDir))
  } catch {
    return null
  }
}

export interface CaptureTurnVersionsResult {
  saved: number
}

/** agent:end 后调用；失败静默（版本内容不是对话主流程） */
export async function captureTurnTextVersions(opts: {
  workspaceDir: string
  messageId: string
  changes: readonly { path: string; status: 'added' | 'modified' | 'deleted' }[]
}): Promise<CaptureTurnVersionsResult> {
  const messageId = safeTurnId(opts.messageId)
  const root = await resolveRoot(opts.workspaceDir)
  if (!messageId || !root) return { saved: 0 }

  const seen = new Set<string>()
  let saved = 0
  for (const change of opts.changes) {
    if (saved >= MAX_FILES_PER_TURN) break
    if (change.status === 'deleted') continue
    const rel = change.path.replace(/\\/g, '/')
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    if (!isTextArtifactPath(rel)) continue
    const role = classifyArtifact({ path: rel })
    if (role !== 'deliverable') continue

    const abs = path.join(root, ...rel.split('/'))
    if (!inside(root, abs)) continue
    try {
      const stat = await fs.lstat(abs)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) continue
      const real = await fs.realpath(abs)
      if (!inside(root, real)) continue
      const dest = destFor(root, messageId, rel)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.copyFile(real, dest)
      saved += 1
    } catch {
      // 文件被清理/锁定：跳过，回退 VCS
    }
  }
  return { saved }
}

export async function hasTurnTextVersion(opts: {
  workspaceDir: string
  messageId: string
  path: string
}): Promise<boolean> {
  const messageId = safeTurnId(opts.messageId)
  const root = await resolveRoot(opts.workspaceDir)
  if (!messageId || !root) return false
  const abs = destFor(root, messageId, opts.path.replace(/\\/g, '/'))
  if (!inside(root, abs)) return false
  try {
    const stat = await fs.stat(abs)
    return stat.isFile() && stat.size <= MAX_FILE_BYTES
  } catch {
    return false
  }
}

export async function readTurnTextVersion(opts: {
  workspaceDir: string
  messageId: string
  path: string
}): Promise<string | null> {
  const messageId = safeTurnId(opts.messageId)
  const root = await resolveRoot(opts.workspaceDir)
  if (!messageId || !root) return null
  const abs = destFor(root, messageId, opts.path.replace(/\\/g, '/'))
  if (!inside(root, abs)) return null
  try {
    const stat = await fs.stat(abs)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    const bytes = await fs.readFile(abs)
    return bytes.includes(0) ? null : bytes.toString('utf8')
  } catch {
    return null
  }
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(abs)
      if (stat.isDirectory()) total += await dirBytes(abs)
      else total += stat.size
    } catch {
      // 已删除
    }
  }
  return total
}

/** 每日清理：按 30 天 / 500MB 上限删回合副本（meta 不在，直接删目录） */
export async function pruneTurnVersions(opts: {
  workspaceDir: string
  now?: number
  maxAgeDays?: number
  maxBytes?: number
}): Promise<{ removedDirs: number; freedBytes: number }> {
  const root = await resolveRoot(opts.workspaceDir)
  if (!root) return { removedDirs: 0, freedBytes: 0 }
  const base = path.join(root, ...VERSIONS_DIR.split('/'))
  const now = opts.now ?? Date.now()
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  let entries
  try {
    entries = await fs.readdir(base, { withFileTypes: true })
  } catch {
    return { removedDirs: 0, freedBytes: 0 }
  }

  const dirs: Array<{ dir: string; at: number; bytes: number }> = []
  let total = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('turn-')) continue
    const dir = path.join(base, entry.name)
    try {
      const stat = await fs.stat(dir)
      const bytes = await dirBytes(dir)
      dirs.push({ dir, at: stat.mtimeMs, bytes })
      total += bytes
    } catch {
      // skip
    }
  }

  let removedDirs = 0
  let freedBytes = 0
  dirs.sort((a, b) => a.at - b.at)
  for (const item of dirs) {
    if (now - item.at <= maxAgeMs && total <= maxBytes) continue
    try {
      await fs.rm(item.dir, { recursive: true, force: true })
      total -= item.bytes
      removedDirs += 1
      freedBytes += item.bytes
    } catch {
      // 下次再试
    }
  }
  return { removedDirs, freedBytes }
}
