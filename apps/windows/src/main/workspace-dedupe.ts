/**
 * 中间产物内容去重（P2 T9）
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §4.8
 *
 * - **只处理中间产物**（`classifyArtifact === 'intermediate'`），成品/临时/内部一律不碰；
 * - 只手动触发，不接自动清理；
 * - 用**硬链接**（同卷）替换重复文件：路径不变、内容不变、仍能打开；
 * - 被成品引用的文件名跳过（宁可少省空间，也不制造死链）；
 * - apply 先 rename 到 `.lumii/tmp/dedupe/` → `link` → 校验 inode → 删临时副本；
 *   中途崩掉时下一次 `recoverDedupeTemps` 会把临时副本放回原位。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveClientStateDir } from './paths'
import { classifyArtifact } from '../shared/artifact-rules'
import type {
  DedupeApplyResult,
  DedupeFailure,
  DedupeGroup,
  DedupePlan,
  DedupePlanResult,
  DedupeSkipped,
} from '../shared/workspace-dedupe-types'
import { DEDUPE_MIN_AGE_MS, DEDUPE_MIN_BYTES } from '../shared/workspace-dedupe-types'
import {
  appendCleanupAudit,
  collectWorkspaceReferenceNames,
  listWorkspaceFiles,
  type WalkedFile,
} from './workspace-cleanup'

const TMP_DIR = '.lumii/tmp/dedupe'
const JOURNAL = '.lumii/tmp/dedupe-journal.json'
const DEFAULT_BUDGET_MS = 30_000
const HASH_BUDGET_MS = 30_000
const MAX_SKIPPED = 50

interface JournalEntry {
  tmp: string
  target: string
  keep: string
}

async function sha256File(abs: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function journalPath(root: string): Promise<string> {
  return path.join(root, ...JOURNAL.split('/'))
}

async function writeJournal(root: string, entries: readonly JournalEntry[]): Promise<void> {
  const file = await journalPath(root)
  if (entries.length === 0) {
    await fs.rm(file, { force: true }).catch(() => undefined)
    return
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ entries }), 'utf8')
  await fs.rename(tmp, file)
}

async function readJournal(root: string): Promise<JournalEntry[]> {
  try {
    const raw = await fs.readFile(await journalPath(root), 'utf8')
    const parsed = JSON.parse(raw) as { entries?: unknown }
    if (!Array.isArray(parsed.entries)) return []
    return parsed.entries.filter(
      (entry): entry is JournalEntry =>
        Boolean(entry) &&
        typeof (entry as JournalEntry).tmp === 'string' &&
        typeof (entry as JournalEntry).target === 'string' &&
        typeof (entry as JournalEntry).keep === 'string',
    )
  } catch {
    return []
  }
}

/**
 * 崩溃恢复：把 `.lumii/tmp/dedupe/` 里残留的临时副本放回原位。
 * 正常结束时 journal 已删；有残留说明上一次 apply 中途挂了。
 */
export async function recoverDedupeTemps(opts: {
  dir: string
}): Promise<{ restored: number; dropped: number }> {
  const root = path.resolve(opts.dir)
  const entries = await readJournal(root)
  if (entries.length === 0) {
    await fs.rm(await journalPath(root), { force: true }).catch(() => undefined)
    return { restored: 0, dropped: 0 }
  }
  let restored = 0
  let dropped = 0
  for (const entry of entries) {
    const tmpAbs = path.join(root, ...entry.tmp.split('/'))
    const targetAbs = path.join(root, ...entry.target.split('/'))
    const tmpExists = await fs.stat(tmpAbs).then(
      () => true,
      () => false,
    )
    if (!tmpExists) continue
    const targetExists = await fs.stat(targetAbs).then(
      () => true,
      () => false,
    )
    if (targetExists) {
      // 目标已经在了（link 成功但没来得及删临时）：临时副本是多余的一份
      await fs.rm(tmpAbs, { force: true }).catch(() => undefined)
      dropped += 1
      continue
    }
    await fs.mkdir(path.dirname(targetAbs), { recursive: true })
    await fs.rename(tmpAbs, targetAbs).catch(() => undefined)
    restored += 1
  }
  await fs.rm(await journalPath(root), { force: true }).catch(() => undefined)
  return { restored, dropped }
}

function skippedReason(file: WalkedFile, now: number, minAgeMs: number, minBytes: number): string | null {
  if (file.symlink) return 'symlink'
  if (file.bytes < minBytes) return 'too-small'
  if (file.mtimeMs > now - minAgeMs) return 'too-recent'
  return null
}

/** 计划去重：只读，不写盘 */
export async function planDedupe(opts: {
  dir: string
  budgetMs?: number
  hashBudgetMs?: number
  minBytes?: number
  minAgeMs?: number
  now?: number
}): Promise<DedupePlanResult | DedupeFailure> {
  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.dir))
  } catch {
    return { ok: false, error: '工作区不可用' }
  }
  const now = opts.now ?? Date.now()
  const minBytes = opts.minBytes ?? DEDUPE_MIN_BYTES
  const minAgeMs = opts.minAgeMs ?? DEDUPE_MIN_AGE_MS

  await recoverDedupeTemps({ dir: root }).catch(() => undefined)

  const { files, truncated } = await listWorkspaceFiles({
    dir: root,
    budgetMs: opts.budgetMs ?? DEFAULT_BUDGET_MS,
  })
  const deliverables = files.filter(
    (file) => !file.symlink && classifyArtifact({ path: file.rel }) === 'deliverable',
  )
  const references = await collectWorkspaceReferenceNames(deliverables, 25_000)
  if (references.truncated) {
    return {
      ok: true,
      plan: {
        groups: [],
        totalFiles: 0,
        reclaimableBytes: 0,
        skipped: [],
        truncated: true,
      },
    }
  }

  const skipped: DedupeSkipped[] = []
  const candidates: WalkedFile[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (classifyArtifact({ path: file.rel }) !== 'intermediate') continue
    const reason = skippedReason(file, now, minAgeMs, minBytes)
    if (reason) {
      if (skipped.length < MAX_SKIPPED) skipped.push({ path: file.rel, reason })
      continue
    }
    if (references.names.has(path.posix.basename(file.rel))) {
      if (skipped.length < MAX_SKIPPED) skipped.push({ path: file.rel, reason: 'referenced' })
      continue
    }
    if (seen.has(file.rel)) continue
    seen.add(file.rel)
    candidates.push(file)
  }

  // 先按大小分组，只有 ≥2 个同尺寸才值得算 hash
  const bySize = new Map<number, WalkedFile[]>()
  for (const file of candidates) {
    const bucket = bySize.get(file.bytes)
    if (bucket) bucket.push(file)
    else bySize.set(file.bytes, [file])
  }

  const groups: DedupeGroup[] = []
  let totalFiles = 0
  let reclaimableBytes = 0
  const hashDeadline = Date.now() + (opts.hashBudgetMs ?? HASH_BUDGET_MS)
  let hashTruncated = false

  for (const [size, bucket] of bySize) {
    if (bucket.length < 2) continue
    if (Date.now() >= hashDeadline) {
      hashTruncated = true
      break
    }
    const byHash = new Map<string, WalkedFile[]>()
    for (const file of bucket) {
      if (Date.now() >= hashDeadline) {
        hashTruncated = true
        break
      }
      let hash: string
      try {
        hash = await sha256File(file.abs)
      } catch {
        if (skipped.length < MAX_SKIPPED) skipped.push({ path: file.rel, reason: 'unreadable' })
        continue
      }
      const list = byHash.get(hash)
      if (list) list.push(file)
      else byHash.set(hash, [file])
    }
    if (hashTruncated) break
    for (const [hash, same] of byHash) {
      if (same.length < 2) continue
      same.sort((a, b) => a.rel.localeCompare(b.rel))
      const keep = same[0]!
      const duplicates = same.slice(1)
      let keepLinks = 1
      try {
        keepLinks = (await fs.stat(keep.abs)).nlink
      } catch {
        keepLinks = 1
      }
      groups.push({
        hash,
        size,
        keep: keep.rel,
        duplicates: duplicates.map((file) => file.rel),
        links: keepLinks + duplicates.length,
      })
      totalFiles += duplicates.length
      reclaimableBytes += size * duplicates.length
    }
  }

  return {
    ok: true,
    plan: {
      groups,
      totalFiles,
      reclaimableBytes,
      skipped,
      truncated: truncated || hashTruncated,
    },
  }
}

/** 应用去重：服务端重新算一次计划（预览与真正动手之间工作区可能又变了） */
export async function applyDedupe(opts: {
  dir: string
  budgetMs?: number
  minBytes?: number
  minAgeMs?: number
  logDir?: string
  now?: number
}): Promise<DedupeApplyResult | DedupeFailure> {
  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.dir))
  } catch {
    return { ok: false, error: '工作区不可用' }
  }
  const planned = await planDedupe({
    dir: root,
    ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
    ...(opts.minBytes !== undefined ? { minBytes: opts.minBytes } : {}),
    ...(opts.minAgeMs !== undefined ? { minAgeMs: opts.minAgeMs } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  if (!planned.ok) return planned
  if (planned.plan.truncated) {
    return { ok: false, error: '扫描未完成（工作区较大或引用校验超时），本次未去重' }
  }
  if (planned.plan.groups.length === 0) {
    return { ok: true, linked: 0, freedBytes: 0, failed: [] }
  }

  const tmpDirAbs = path.join(root, ...TMP_DIR.split('/'))
  await fs.mkdir(tmpDirAbs, { recursive: true })
  const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`

  const entries: JournalEntry[] = []
  for (const group of planned.plan.groups) {
    for (const rel of group.duplicates) {
      entries.push({
        tmp: `${TMP_DIR}/${runId}-${entries.length}`,
        target: rel,
        keep: group.keep,
      })
    }
  }
  await writeJournal(root, entries)

  const audit: Array<Record<string, unknown>> = []
  const failed: DedupeSkipped[] = []
  let linked = 0
  let freedBytes = 0
  let entryIndex = 0

  for (const group of planned.plan.groups) {
    const keepAbs = path.join(root, ...group.keep.split('/'))
    let keepIno: number
    try {
      const stat = await fs.stat(keepAbs)
      if (!stat.isFile()) throw new Error('keep 不是文件')
      keepIno = stat.ino
    } catch (err) {
      for (const rel of group.duplicates) {
        failed.push({ path: rel, reason: err instanceof Error ? err.message : '保留文件不可用' })
        entryIndex += 1
      }
      continue
    }

    for (const rel of group.duplicates) {
      const entry = entries[entryIndex]!
      entryIndex += 1
      const targetAbs = path.join(root, ...rel.split('/'))
      const tmpAbs = path.join(root, ...entry.tmp.split('/'))
      try {
        // 应用前再确认一次：路径仍是中间产物、确实存在
        if (classifyArtifact({ path: rel }) !== 'intermediate') {
          failed.push({ path: rel, reason: 'not-intermediate' })
          continue
        }
        await fs.rename(targetAbs, tmpAbs)
      } catch (err) {
        failed.push({
          path: rel,
          reason: err instanceof Error ? err.message : '无法移开目标文件',
        })
        continue
      }
      try {
        await fs.link(keepAbs, targetAbs)
        const linkedStat = await fs.stat(targetAbs)
        if (linkedStat.ino !== keepIno || linkedStat.size !== group.size) {
          await fs.rm(targetAbs, { force: true })
          throw new Error('链接校验不一致')
        }
        await fs.rm(tmpAbs, { force: true })
        linked += 1
        freedBytes += group.size
        audit.push({
          at: new Date().toISOString(),
          action: 'dedupe',
          path: rel,
          keep: group.keep,
          bytes: group.size,
          trigger: 'dedupe',
        })
      } catch (err) {
        // 失败：把临时副本放回原位（目标可能不存在）
        await fs.rename(tmpAbs, targetAbs).catch(() => undefined)
        const code = (err as NodeJS.ErrnoException).code ?? ''
        failed.push({
          path: rel,
          reason: code === 'EXDEV' ? '跨卷不支持硬链接' : err instanceof Error ? err.message : '硬链接失败',
        })
      }
    }
  }

  await writeJournal(root, []).catch(() => undefined)
  await fs.rmdir(tmpDirAbs).catch(() => undefined)
  await appendCleanupAudit(opts.logDir ?? path.join(resolveClientStateDir(), 'logs'), audit)

  return { ok: true, linked, freedBytes, failed }
}
