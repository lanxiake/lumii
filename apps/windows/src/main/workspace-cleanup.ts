/**
 * 工作区清理服务
 *
 * 三条硬约束（都是踩过坑写下的）：
 * 1. **只动过程文件**：分类走 `shared/artifact-rules`（与 rail 同一份规则），
 *    认不出的一律 deliverable，不删。
 * 2. **不进 trash 不算删除**：先 rename 到 `<ws>/.lumii/trash/<id>/`，用户可恢复；
 *    绝不用 `rmSync`（曾用同步递归删 1 万文件，主线程冻结 1565ms）。
 * 3. **不阻塞主线程**：全程 `fs.promises` + 时间预算（超时返回 truncated）。
 *
 * 被成品引用的中间文件会被跳过（保守：宁可少删）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveClientStateDir } from './paths'
import { classifyArtifact, extOf } from '../shared/artifact-rules'
import { normalizeArtifactPath } from '../shared/artifact-declaration'

import type {
  CleanupCandidate,
  CleanupClassStats,
  CleanupRole,
  CleanupRunResult,
  CleanupScan,
  CleanupSkipped,
  CleanupTrashEntry,
  CleanupRestoreResult,
} from '../shared/workspace-cleanup-types'
import type { ArtifactTrashResult as CleanupTrashResult } from '../shared/artifact-export-types'

const DEFAULT_SCAN_BUDGET_MS = 1500
const MIN_AGE_MS = 60 * 60 * 1000
const MAX_TEXT_REFERENCE_BYTES = 2 * 1024 * 1024
const TEXT_REFERENCE_EXTENSIONS = new Set(['html', 'htm', 'svg', 'json', 'md', 'js', 'css', 'txt'])
const TRASH_DIR_NAME = path.join('.lumii', 'trash')
const INTERNAL_WALK_SEGMENTS = new Set(['.git', 'node_modules', '.cache', '.lumii'])

interface WalkedFile {
  rel: string
  abs: string
  bytes: number
  mtimeMs: number
  symlink: boolean
}

interface WalkResult {
  files: WalkedFile[]
  truncated: boolean
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

function insideWorkspace(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 只有这两个根会被深扫；其余的位置只做浅统计（设计 §13） */
const CLEANUP_ROOTS = ['outputs', 'temp'] as const

/** 深扫一个根；返回是否因预算截断 */
async function walkDir(
  absRoot: string,
  relRoot: string,
  deadline: number,
  out: WalkedFile[],
): Promise<boolean> {
  const queue: Array<{ abs: string; rel: string }> = [{ abs: absRoot, rel: relRoot }]
  while (queue.length > 0) {
    if (Date.now() > deadline) return true
    const dir = queue.pop()!
    let entries
    try {
      entries = await fs.readdir(dir.abs, { withFileTypes: true })
    } catch {
      continue
    }
    const plainFiles: Array<{ abs: string; rel: string }> = []
    for (const entry of entries) {
      const abs = path.join(dir.abs, entry.name)
      const rel = `${dir.rel}/${toPosix(entry.name)}`
      if (entry.isSymbolicLink()) {
        out.push({ rel, abs, bytes: 0, mtimeMs: 0, symlink: true })
        continue
      }
      if (entry.isDirectory()) {
        if (INTERNAL_WALK_SEGMENTS.has(entry.name)) continue
        queue.push({ abs, rel })
        continue
      }
      if (entry.isFile()) plainFiles.push({ abs, rel })
    }
    // 批量 stat（每批 64）：串行 stat 是扫描慢的主因，13k 文件要 1s+
    for (let start = 0; start < plainFiles.length; start += 64) {
      if (Date.now() > deadline) return true
      const batch = plainFiles.slice(start, start + 64)
      const stats = await Promise.all(
        batch.map(async (file) => {
          try {
            return await fs.stat(file.abs)
          } catch {
            return null
          }
        }),
      )
      stats.forEach((stat, index) => {
        if (!stat) return
        const file = batch[index]!
        out.push({
          rel: file.rel,
          abs: file.abs,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
          symlink: false,
        })
      })
    }
  }
  return false
}

/**
 * 收集工作区文件：`outputs/`、`temp/` 深扫（清理只动这两个根），
 * 其余顶层位置只统计「自己 + 下一层文件」，不递归——工作区里
 * `node_modules`、同步目录之类的大树不该为了一次清理被走一遍。
 */
async function collectWorkspaceFiles(root: string, budgetMs: number): Promise<WalkResult> {
  const files: WalkedFile[] = []
  const deadline = Date.now() + budgetMs
  let truncated = false

  for (const name of CLEANUP_ROOTS) {
    const abs = path.join(root, name)
    try {
      const stat = await fs.stat(abs)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }
    if (await walkDir(abs, name, deadline, files)) {
      truncated = true
      break
    }
  }

  if (truncated) return { files, truncated }

  // 浅统计：顶层文件 + 其它目录的第一层文件
  let topLevel
  try {
    topLevel = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return { files, truncated }
  }
  for (const entry of topLevel) {
    if (Date.now() > deadline) return { files, truncated: true }
    if ((CLEANUP_ROOTS as readonly string[]).includes(entry.name)) continue
    if (INTERNAL_WALK_SEGMENTS.has(entry.name) || entry.name.startsWith('.')) continue
    const abs = path.join(root, entry.name)
    if (entry.isFile()) {
      try {
        const stat = await fs.stat(abs)
        files.push({
          rel: toPosix(entry.name),
          abs,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
          symlink: false,
        })
      } catch {
        // ignore
      }
      continue
    }
    if (!entry.isDirectory()) continue
    let children
    try {
      children = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isFile()) continue
      const childAbs = path.join(abs, child.name)
      try {
        const stat = await fs.stat(childAbs)
        files.push({
          rel: `${toPosix(entry.name)}/${toPosix(child.name)}`,
          abs: childAbs,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
          symlink: false,
        })
      } catch {
        // ignore
      }
    }
  }

  return { files, truncated }
}

/** 成品里被引用的文件名集合（html 里的 `<img src>`、md 里的相对链接等） */
async function collectReferencedNames(
  files: readonly WalkedFile[],
  deadline: number,
): Promise<{ names: Set<string>; truncated: boolean }> {
  const referenced = new Set<string>()
  const tokenPattern = /[\w一-龥.-]+\.[A-Za-z0-9]{1,6}/g
  for (const file of files) {
    if (Date.now() > deadline) return { names: referenced, truncated: true }
    if (file.symlink || file.bytes === 0 || file.bytes > MAX_TEXT_REFERENCE_BYTES) continue
    if (!TEXT_REFERENCE_EXTENSIONS.has(extOf(file.rel))) continue
    try {
      const text = await fs.readFile(file.abs, 'utf8')
      for (const token of text.match(tokenPattern) ?? []) {
        referenced.add(path.posix.basename(toPosix(token)))
      }
    } catch {
      // 读失败不影响清理；最坏是多留几个文件
    }
  }
  return { names: referenced, truncated: false }
}

function emptyStats(): CleanupClassStats {
  return { count: 0, bytes: 0 }
}

function skippedReason(file: WalkedFile, now: number): CleanupSkipped['reason'] | null {
  if (file.symlink) return 'symlink'
  if (file.mtimeMs > now - MIN_AGE_MS) return 'too-recent'
  return null
}

/** 扫描工作区：四类统计 + 体积最大的 20 个可清候选 */
export async function scanWorkspace(opts: {
  dir: string
  budgetMs?: number
}): Promise<CleanupScan> {
  const root = path.resolve(opts.dir)
  const now = Date.now()
  const { files, truncated } = await collectWorkspaceFiles(
    root,
    opts.budgetMs ?? DEFAULT_SCAN_BUDGET_MS,
  )

  const classes: CleanupScan['classes'] = {
    deliverable: emptyStats(),
    intermediate: emptyStats(),
    ephemeral: emptyStats(),
    internal: emptyStats(),
  }
  const allCandidates: CleanupCandidate[] = []
  const skipped: CleanupSkipped[] = []

  for (const file of files) {
    if (!insideWorkspace(root, file.abs)) continue
    const role = classifyArtifact({ path: file.rel })
    classes[role].count += 1
    classes[role].bytes += file.bytes
    if (role !== 'intermediate' && role !== 'ephemeral') continue

    const reason = skippedReason(file, now)
    if (reason) {
      if (skipped.length < 100) skipped.push({ path: file.rel, reason })
      continue
    }
    allCandidates.push({ path: file.rel, role, bytes: file.bytes, mtimeMs: file.mtimeMs })
  }

  allCandidates.sort((a, b) => b.bytes - a.bytes)

  return {
    workspaceDir: toPosix(root),
    classes,
    candidates: allCandidates.slice(0, 20),
    skipped,
    truncated,
    scannedAt: now,
  }
}

/** 同一时刻只允许一个清理任务 */
let running: Promise<CleanupRunResult> | null = null

function pickRoles(target: 'intermediate' | 'ephemeral' | 'both'): Set<CleanupRole> {
  if (target === 'both') return new Set<CleanupRole>(['intermediate', 'ephemeral'])
  return new Set<CleanupRole>([target])
}

async function appendAuditLog(
  logDir: string,
  lines: Array<Record<string, unknown>>,
): Promise<void> {
  if (lines.length === 0) return
  try {
    await fs.mkdir(logDir, { recursive: true })
    const name = `cleanup-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`
    const payload = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
    await fs.appendFile(path.join(logDir, name), payload, 'utf8')
  } catch {
    // 审计日志写不进去不影响清理本身
  }
}

/**
 * 执行清理：dryRun 只统计；真实删除 = rename 进 trash（可恢复）。
 */
export async function runCleanup(opts: {
  dir: string
  target: 'intermediate' | 'ephemeral' | 'both'
  dryRun: boolean
  logDir?: string
  /** 工具声明为成品的路径：即便路径像中间产物也不删（安全闸优先于约定目录） */
  protectedPaths?: readonly string[]
  /** 测试用：覆盖扫描预算（默认 8s） */
  budgetMs?: number
}): Promise<CleanupRunResult> {
  if (running) return { ok: false, dryRun: opts.dryRun, removed: 0, bytes: 0, skipped: 0, error: '已有清理任务在执行' }

  running = (async (): Promise<CleanupRunResult> => {
    const root = path.resolve(opts.dir)
    const now = Date.now()
    const budgetMs = opts.budgetMs ?? 8000
    // 清理只考虑 outputs/ 与 temp/；引用扫描也只在这两棵树里找成品
    const { files, truncated } = await collectWorkspaceFiles(root, budgetMs)
    if (truncated) {
      // 列举不全 → 「被引用」安全闸必然有盲区，宁可什么都不删
      return {
        ok: false,
        dryRun: opts.dryRun,
        removed: 0,
        bytes: 0,
        skipped: 0,
        error: '文件太多，本次扫描未完成；已中止（可稍后重试）',
      }
    }
    const roles = pickRoles(opts.target)

    // 参考集：成品里出现的文件名 → 对应候选跳过
    const deliverables = files.filter(
      (file) => !file.symlink && classifyArtifact({ path: file.rel }) === 'deliverable',
    )
    const referenceScan = await collectReferencedNames(deliverables, Date.now() + 3000)
    if (referenceScan.truncated) {
      return {
        ok: false,
        dryRun: opts.dryRun,
        removed: 0,
        bytes: 0,
        skipped: 0,
        error: '引用校验未完成；已中止（可稍后重试）',
      }
    }
    const referencedNames = referenceScan.names

    const protectedSet = new Set<string>()
    for (const raw of opts.protectedPaths ?? []) {
      if (typeof raw !== 'string') continue
      const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '')
      if (normalized) protectedSet.add(normalized)
    }

    const selected: CleanupCandidate[] = []
    let skipped = 0

    for (const file of files) {
      const role = classifyArtifact({ path: file.rel })
      if (role !== 'intermediate' && role !== 'ephemeral') continue
      if (!roles.has(role)) continue
      if (protectedSet.has(file.rel)) {
        // 声明为成品的，哪怕长得像过程文件也不动
        skipped += 1
        continue
      }
      if (!insideWorkspace(root, file.abs)) {
        skipped += 1
        continue
      }
      if (skippedReason(file, now)) {
        skipped += 1
        continue
      }
      if (referencedNames.has(path.posix.basename(file.rel))) {
        skipped += 1
        continue
      }
      selected.push({ path: file.rel, role, bytes: file.bytes, mtimeMs: file.mtimeMs })
    }

    const totalBytes = selected.reduce((sum, item) => sum + item.bytes, 0)
    if (opts.dryRun) {
      return { ok: true, dryRun: true, removed: selected.length, bytes: totalBytes, skipped }
    }

    const trashId = `${now}-${Math.random().toString(36).slice(2, 8)}`
    const trashRoot = path.join(root, TRASH_DIR_NAME, trashId)
    let removed = 0
    let bytes = 0
    const audit: Array<Record<string, unknown>> = []

    for (const candidate of selected) {
      const abs = path.join(root, ...candidate.path.split('/'))
      const dest = path.join(trashRoot, ...candidate.path.split('/'))
      try {
        // 删除前再验一次：清理期间用户可能已经换掉文件
        const stat = await fs.lstat(abs)
        if (stat.isSymbolicLink()) {
          skipped += 1
          continue
        }
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.rename(abs, dest)
        removed += 1
        bytes += candidate.bytes
        audit.push({
          at: new Date().toISOString(),
          action: 'trash',
          trashId,
          path: candidate.path,
          role: candidate.role,
          bytes: candidate.bytes,
        })
      } catch (err) {
        skipped += 1
        audit.push({
          at: new Date().toISOString(),
          action: 'skip',
          path: candidate.path,
          reason: (err as NodeJS.ErrnoException).code ?? 'error',
        })
      }
    }

    await appendAuditLog(opts.logDir ?? path.join(resolveClientStateDir(), 'logs'), audit)

    return { ok: true, dryRun: false, removed, bytes, skipped, trashId }
  })().finally(() => {
    running = null
  })

  return running
}

function trashRootOf(root: string): string {
  return path.join(root, TRASH_DIR_NAME)
}

function safeTrashId(id: string): boolean {
  return id !== '.' && id !== '..' && /^[\w.-]+$/.test(id) && !id.includes('..')
}

async function measureDir(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const queue = [root]
  while (queue.length > 0) {
    const dir = queue.pop()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(abs)
      } else if (entry.isFile()) {
        files += 1
        try {
          bytes += (await fs.stat(abs)).size
        } catch {
          // ignore
        }
      }
    }
  }
  return { bytes, files }
}

/** 回收站列表（倒序） */
export async function listTrash(opts: { dir: string }): Promise<CleanupTrashEntry[]> {
  const root = trashRootOf(path.resolve(opts.dir))
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: CleanupTrashEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeTrashId(entry.name)) continue
    const abs = path.join(root, entry.name)
    const { bytes, files } = await measureDir(abs)
    const created = Number(entry.name.split('-')[0])
    out.push({
      id: entry.name,
      createdAt: Number.isFinite(created) && created > 0 ? created : 0,
      bytes,
      files,
    })
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

/** 从回收站恢复：目标已存在则跳过（不覆盖用户现文件） */
export async function restoreTrash(opts: { dir: string; id: string }): Promise<CleanupRestoreResult> {
  const root = path.resolve(opts.dir)
  if (!safeTrashId(opts.id)) return { ok: false, restored: 0, conflicts: 0, error: '非法的回收站 id' }
  const trashDir = path.join(trashRootOf(root), opts.id)

  const queue: Array<{ abs: string; rel: string }> = [{ abs: trashDir, rel: '' }]
  let restored = 0
  let conflicts = 0

  while (queue.length > 0) {
    const current = queue.pop()!
    let entries
    try {
      entries = await fs.readdir(current.abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(current.abs, entry.name)
      const rel = current.rel ? `${current.rel}/${toPosix(entry.name)}` : toPosix(entry.name)
      if (entry.isDirectory()) {
        queue.push({ abs, rel })
        continue
      }
      const dest = path.join(root, ...rel.split('/'))
      if (!insideWorkspace(root, dest)) {
        conflicts += 1
        continue
      }
      try {
        await fs.access(dest)
        conflicts += 1
        continue
      } catch {
        // 目标不存在，可恢复
      }
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.rename(abs, dest)
        restored += 1
      } catch {
        conflicts += 1
      }
    }
  }

  // 恢复会把文件搬走，但嵌套目录会留下；自底向上清空壳（有剩余文件就保留）
  await pruneEmptyDirs(trashDir)

  return { ok: true, restored, conflicts }
}

/** 递归删除空目录；返回该目录是否已被删除 */
async function pruneEmptyDirs(dir: string): Promise<boolean> {  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneEmptyDirs(path.join(dir, entry.name))
  }
  try {
    const left = await fs.readdir(dir)
    if (left.length === 0) {
      await fs.rmdir(dir)
      return true
    }
  } catch {
    // ignore
  }
  return false
}

/**
 * 把指定路径移入回收站（用户显式删除 / 会话删除联动）。
 *
 * 与 `runCleanup` 的三点不同：
 * - 不看 mtime（用户刚生成的东西也可能想删，1 小时门槛在这里只会挡人）；
 * - 不看角色（成品也能删——用户点了就是点了）；
 * - 只处理「点名的那几个文件」，不做目录遍历。
 *
 * 仍然保留的安全闸：路径归一（拒绝绝对路径/`..`）、`lstat` 拒符号链接、
 * 越界拒绝、被其它成品按文件名引用时跳过（删了会让 html/md 里出现死链）。
 */
export async function trashPaths(opts: {
  dir: string
  paths: readonly unknown[]
  logDir?: string
  /** 引用校验的扫描预算；超预算就拒绝（宁可不动，也不留死链） */
  budgetMs?: number
}): Promise<CleanupTrashResult> {
  const root = path.resolve(opts.dir)
  if (!Array.isArray(opts.paths) || opts.paths.length === 0) {
    return { ok: false, removed: 0, bytes: 0, skipped: 0, error: '没有要删除的文件' }
  }

  const targets: WalkedFile[] = []
  let skipped = 0
  const seen = new Set<string>()

  for (const raw of opts.paths) {
    const rel = normalizeArtifactPath(raw)
    if (!rel) {
      skipped += 1
      continue
    }
    if (seen.has(rel)) continue
    seen.add(rel)
    const abs = path.join(root, ...rel.split('/'))
    if (!insideWorkspace(root, abs)) {
      skipped += 1
      continue
    }
    let stat
    try {
      stat = await fs.lstat(abs)
    } catch {
      skipped += 1
      continue
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      skipped += 1
      continue
    }
    targets.push({ rel, abs, bytes: stat.size, mtimeMs: stat.mtimeMs, symlink: false })
  }

  if (targets.length === 0) {
    return { ok: false, removed: 0, bytes: 0, skipped, error: '没有可删除的文件' }
  }

  // 引用校验：只扫 outputs/temp 里的成品
  const { files, truncated } = await collectWorkspaceFiles(root, opts.budgetMs ?? 3000)
  if (truncated) {
    return { ok: false, removed: 0, bytes: 0, skipped, error: '工作区文件太多，未能校验引用关系；未删除任何文件' }
  }
  const deliverables = files.filter(
    (file) => !file.symlink && classifyArtifact({ path: file.rel }) === 'deliverable',
  )
  const referenceScan = await collectReferencedNames(deliverables, Date.now() + 3000)
  if (referenceScan.truncated) {
    return { ok: false, removed: 0, bytes: 0, skipped, error: '引用校验未完成；未删除任何文件' }
  }
  const referenced = referenceScan.names

  const now = Date.now()
  const trashId = `${now}-${Math.random().toString(36).slice(2, 8)}`
  const trashRoot = path.join(root, TRASH_DIR_NAME, trashId)
  let removed = 0
  let bytes = 0
  const audit: Array<Record<string, unknown>> = []

  for (const target of targets) {
    if (referenced.has(path.posix.basename(target.rel))) {
      skipped += 1
      audit.push({ at: new Date().toISOString(), action: 'skip', path: target.rel, reason: 'referenced' })
      continue
    }
    const dest = path.join(trashRoot, ...target.rel.split('/'))
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.rename(target.abs, dest)
      removed += 1
      bytes += target.bytes
      audit.push({
        at: new Date().toISOString(),
        action: 'trash',
        trashId,
        path: target.rel,
        role: classifyArtifact({ path: target.rel }),
        bytes: target.bytes,
        trigger: 'manual',
      })
    } catch (err) {
      skipped += 1
      audit.push({
        at: new Date().toISOString(),
        action: 'skip',
        path: target.rel,
        reason: (err as NodeJS.ErrnoException).code ?? 'error',
      })
    }
  }

  await appendAuditLog(opts.logDir ?? path.join(resolveClientStateDir(), 'logs'), audit)

  return { ok: true, removed, bytes, skipped, ...(removed > 0 ? { trashId } : {}) }
}
