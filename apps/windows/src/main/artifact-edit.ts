/**
 * 产物就地修改的底座（P2）
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §4.1 / §4.2
 *
 * 职责：
 * - 把「候选稿」落到 `<ws>/.lumii/edits/<editId>/`（before / candidate / meta）；
 * - `applyEdit` 校验 baseHash 后原子替换目标文件；
 * - 应用后写一条编辑索引（rail / 版本历史用）；
 * - undo / discard / 保留上限清理。
 *
 * 这里只做文本与「已有候选文件」两种底座；LLM 提示词在 T2、PPT 脚本在 T4 接。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { normalizeArtifactPath } from '../shared/artifact-declaration'
import type {
  ArtifactEditAction,
  ArtifactEditApplyResult,
  ArtifactEditFailure,
  ArtifactEditProposal,
  ArtifactEditScope,
  ArtifactEditUndoResult,
  ArtifactEditListResult,
  LocalArtifactEdit,
  ProposeTextEditInput,
} from '../shared/artifact-edit-types'
import { classifyArtifact, isTextArtifactPath } from '../shared/artifact-rules'

const EDIT_DIR = '.lumii/edits'
const INDEX_FILE = 'index.jsonl'
const STALE_PROPOSAL_MS = 24 * 60 * 60 * 1000
const MAX_TEXT_EDIT_BYTES = 10 * 1024 * 1024
const MAX_REPLACEMENT_CHARS = 2_000_000
const EDIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/
/** 手工保存的连续写入合并窗口 */
const MANUAL_MERGE_MS = 60_000

export interface EditTarget {
  root: string
  /** 工作区相对路径（posix） */
  rel: string
  /** realpath 后的绝对路径 */
  abs: string
  bytes: number
}

interface EditMeta {
  editId: string
  sessionKey: string | null
  path: string
  action: ArtifactEditAction
  scope: ArtifactEditScope
  instruction?: string
  at: number
  status: 'proposed' | 'applied' | 'discarded'
  baseHash: string
  candidateHash?: string
  beforeFile: string
  candidateFile: string
  originalBytes: number
  appliedAt?: number
  contentPruned?: boolean
  derivedFrom?: string
}

export interface AppliedEditInfo {
  editId: string
  sessionKey: string | null
  path: string
  absPath: string
  action: ArtifactEditAction
  bytes: number
  derivedFrom?: string
}

function fail(
  error: string,
  code: ArtifactEditFailure['code'] = 'unavailable',
): ArtifactEditFailure {
  return { ok: false, error, code }
}

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function toRelPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function sha256File(abs: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function normalizeSessionKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null
}

function normalizeEditId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return EDIT_ID_RE.test(value) ? value : null
}

function newEditId(): string {
  return `edit-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/** 解析编辑目标：只接受工作区内、非 internal/ephemeral、非符号链接的普通文件 */
export async function resolveEditTarget(
  workspaceDir: string,
  relPath: unknown,
): Promise<EditTarget | null> {
  const rel = normalizeArtifactPath(relPath)
  if (!rel) return null
  const role = classifyArtifact({ path: rel })
  if (role === 'internal' || role === 'ephemeral') return null

  let root: string
  try {
    root = await fs.realpath(path.resolve(workspaceDir))
  } catch {
    return null
  }
  const abs = path.join(root, ...rel.split('/'))
  if (!inside(root, abs)) return null
  try {
    const stat = await fs.lstat(abs)
    if (stat.isSymbolicLink() || !stat.isFile()) return null
    const real = await fs.realpath(abs)
    if (!inside(root, real)) return null
    return { root, rel, abs: real, bytes: stat.size }
  } catch {
    return null
  }
}

function editDirFor(root: string, editId: string): string {
  return path.join(root, ...EDIT_DIR.split('/'), editId)
}

function indexPathFor(root: string): string {
  return path.join(root, ...EDIT_DIR.split('/'), INDEX_FILE)
}

async function readMeta(editDir: string): Promise<EditMeta | null> {
  try {
    const raw = await fs.readFile(path.join(editDir, 'meta.json'), 'utf8')
    const parsed = JSON.parse(raw) as EditMeta
    if (!parsed || typeof parsed.editId !== 'string' || parsed.editId.length === 0) return null
    return parsed
  } catch {
    return null
  }
}

async function writeMeta(editDir: string, meta: EditMeta): Promise<void> {
  await fs.writeFile(path.join(editDir, 'meta.json'), JSON.stringify(meta), 'utf8')
}

async function appendIndex(root: string, meta: EditMeta): Promise<void> {
  const entry = {
    editId: meta.editId,
    sessionKey: meta.sessionKey,
    path: meta.path,
    action: meta.action,
    scope: meta.scope,
    at: meta.at,
    appliedAt: meta.appliedAt,
    bytes: meta.originalBytes,
    ...(meta.derivedFrom ? { derivedFrom: meta.derivedFrom } : {}),
  }
  await fs.appendFile(indexPathFor(root), `${JSON.stringify(entry)}\n`, 'utf8')
}

/** 同目录临时文件 + rename：中途失败不留半个目标文件 */
async function writeAtomic(absPath: string, bytes: Buffer): Promise<void> {
  const dir = path.dirname(absPath)
  const tmp = path.join(
    dir,
    `.${path.basename(absPath)}.lumii-edit-${randomBytes(4).toString('hex')}.tmp`,
  )
  await fs.writeFile(tmp, bytes)
  try {
    await fs.rename(tmp, absPath)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

interface StageInput {
  target: EditTarget
  sessionKey: string | null
  action: ArtifactEditAction
  scope: ArtifactEditScope
  instruction?: string
  editId?: string
  beforeBytes: Buffer
  candidateBytes: Buffer
  derivedFrom?: string
}

/** 写 before / candidate / meta，返回候选 proposal（不碰目标文件） */
async function stageEdit(input: StageInput): Promise<ArtifactEditProposal | ArtifactEditFailure> {
  const editId = input.editId ? normalizeEditId(input.editId) : newEditId()
  if (!editId) return fail('editId 非法', 'invalid-scope')
  const editDir = editDirFor(input.target.root, editId)
  try {
    // 重入同一个 id 会把已应用的 before/candidate 覆盖掉，直接拒绝
    await fs.access(editDir)
    return fail('editId 已存在', 'invalid-scope')
  } catch {
    // 不存在才继续
  }
  try {
    await fs.mkdir(editDir, { recursive: true })
    const ext = path.extname(input.target.rel) || '.txt'
    const beforeFile = `before${ext}`
    const candidateFile = `candidate${ext}`
    await fs.writeFile(path.join(editDir, beforeFile), input.beforeBytes)
    await fs.writeFile(path.join(editDir, candidateFile), input.candidateBytes)
    const meta: EditMeta = {
      editId,
      sessionKey: input.sessionKey,
      path: input.target.rel,
      action: input.action,
      scope: input.scope,
      ...(input.instruction ? { instruction: input.instruction.slice(0, 500) } : {}),
      at: Date.now(),
      status: 'proposed',
      baseHash: sha256Bytes(input.beforeBytes),
      beforeFile,
      candidateFile,
      originalBytes: input.beforeBytes.byteLength,
      ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}),
    }
    await writeMeta(editDir, meta)
    return {
      ok: true,
      editId,
      candidatePath: toRelPosix(
        input.target.root,
        path.join(editDir, candidateFile),
      ),
      changedScope: input.scope,
      baseHash: meta.baseHash,
      beforeBytes: meta.originalBytes,
      afterBytes: input.candidateBytes.byteLength,
    }
  } catch (err) {
    await fs.rm(editDir, { recursive: true, force: true }).catch(() => undefined)
    return fail(err instanceof Error ? err.message : '无法写入候选稿')
  }
}

/** 文本区间替换（T1 的底座；T2 的 LLM 产出最终也走这里） */
export async function proposeTextEdit(opts: {
  workspaceDir: string
  input: ProposeTextEditInput
}): Promise<ArtifactEditProposal | ArtifactEditFailure> {
  const { input } = opts
  const target = await resolveEditTarget(opts.workspaceDir, input.path)
  if (!target) return fail('目标文件不存在或不在工作区内', 'invalid-path')
  if (target.bytes > MAX_TEXT_EDIT_BYTES) {
    return fail(`文件太大（${target.bytes} 字节，上限 10MB）`, 'unavailable')
  }
  if (
    !Number.isInteger(input.start) ||
    !Number.isInteger(input.end) ||
    input.start < 0 ||
    input.end <= input.start
  ) {
    return fail('替换区间非法', 'invalid-scope')
  }
  if (typeof input.replacement !== 'string' || input.replacement.length > MAX_REPLACEMENT_CHARS) {
    return fail('替换内容非法或过长', 'invalid-scope')
  }

  let content: string
  try {
    content = await fs.readFile(target.abs, 'utf8')
  } catch (err) {
    return fail(err instanceof Error ? err.message : '读取文件失败')
  }
  if (content.includes('\0')) return fail('目标不是文本文件', 'invalid-path')
  if (input.end > content.length) return fail('替换区间超出文件长度', 'invalid-scope')

  const beforeBytes = Buffer.from(content, 'utf8')
  const baseHash = sha256Bytes(beforeBytes)
  if (input.baseHash && input.baseHash !== baseHash) {
    return fail('文件已变化，请刷新后重试', 'conflict')
  }

  const nextContent =
    content.slice(0, input.start) + input.replacement + content.slice(input.end)
  return stageEdit({
    target,
    sessionKey: normalizeSessionKey(input.sessionKey),
    action: input.action ?? 'manual',
    scope: { type: 'text-range', start: input.start, end: input.end },
    ...(input.instruction ? { instruction: input.instruction } : {}),
    ...(input.editId ? { editId: input.editId } : {}),
    beforeBytes,
    candidateBytes: Buffer.from(nextContent, 'utf8'),
  })
}

/**
 * 已有候选文件（PPT 脚本等）走这条：调用方在 `writeCandidate` 里生成候选，
 * 底座负责 before 副本、大小与 meta。
 */
export async function proposeFileEdit(opts: {
  workspaceDir: string
  input: {
    path: unknown
    sessionKey?: string | null
    action: ArtifactEditAction
    scope: ArtifactEditScope
    editId?: string
    instruction?: string
  }
  writeCandidate: (candidateAbs: string) => Promise<void>
}): Promise<ArtifactEditProposal | ArtifactEditFailure> {
  const target = await resolveEditTarget(opts.workspaceDir, opts.input.path)
  if (!target) return fail('目标文件不存在或不在工作区内', 'invalid-path')

  const editId = opts.input.editId ? normalizeEditId(opts.input.editId) : newEditId()
  if (!editId) return fail('editId 非法', 'invalid-scope')
  const editDir = editDirFor(target.root, editId)
  try {
    await fs.access(editDir)
    return fail('editId 已存在', 'invalid-scope')
  } catch {
    // 不存在才继续
  }
  const ext = path.extname(target.rel) || '.bin'
  const beforeFile = `before${ext}`
  const candidateFile = `candidate${ext}`
  try {
    await fs.mkdir(editDir, { recursive: true })
    await fs.copyFile(target.abs, path.join(editDir, beforeFile))
    await opts.writeCandidate(path.join(editDir, candidateFile))
    const candidateStat = await fs.stat(path.join(editDir, candidateFile))
    if (!candidateStat.isFile()) return fail('候选稿没有生成', 'unavailable')
    const baseHash = await sha256File(target.abs)
    const meta: EditMeta = {
      editId,
      sessionKey: normalizeSessionKey(opts.input.sessionKey),
      path: target.rel,
      action: opts.input.action,
      scope: opts.input.scope,
      ...(opts.input.instruction ? { instruction: opts.input.instruction.slice(0, 500) } : {}),
      at: Date.now(),
      status: 'proposed',
      baseHash,
      beforeFile,
      candidateFile,
      originalBytes: target.bytes,
    }
    await writeMeta(editDir, meta)
    return {
      ok: true,
      editId,
      candidatePath: toRelPosix(target.root, path.join(editDir, candidateFile)),
      changedScope: opts.input.scope,
      baseHash,
      beforeBytes: target.bytes,
      afterBytes: candidateStat.size,
    }
  } catch (err) {
    await fs.rm(editDir, { recursive: true, force: true }).catch(() => undefined)
    return fail(err instanceof Error ? err.message : '无法生成候选稿')
  }
}

export async function applyEdit(opts: {
  workspaceDir: string
  editId: unknown
  registerFile?: (info: AppliedEditInfo) => void
}): Promise<ArtifactEditApplyResult | ArtifactEditFailure> {
  const editId = normalizeEditId(opts.editId)
  if (!editId) return fail('editId 非法', 'invalid-scope')

  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.workspaceDir))
  } catch {
    return fail('工作区不可用')
  }
  const editDir = editDirFor(root, editId)
  const meta = await readMeta(editDir)
  if (!meta) return fail('编辑记录不存在', 'not-found')
  if (meta.status !== 'proposed') return fail('该编辑已应用或已取消', 'invalid-scope')

  const target = await resolveEditTarget(root, meta.path)
  if (!target) return fail('目标文件不存在或不在工作区内', 'invalid-path')

  let currentHash: string
  try {
    currentHash = await sha256File(target.abs)
  } catch (err) {
    return fail(err instanceof Error ? err.message : '读取目标文件失败')
  }
  if (currentHash !== meta.baseHash) {
    return fail('文件在预览期间被修改，已拒绝应用', 'conflict')
  }

  let candidateBytes: Buffer
  try {
    candidateBytes = await fs.readFile(path.join(editDir, meta.candidateFile))
  } catch {
    return fail('候选稿不存在，请重新生成', 'not-found')
  }

  try {
    await writeAtomic(target.abs, candidateBytes)
  } catch (err) {
    return fail(err instanceof Error ? err.message : '写入目标文件失败')
  }

  const appliedAt = Date.now()
  const appliedMeta: EditMeta = {
    ...meta,
    status: 'applied',
    appliedAt,
    candidateHash: sha256Bytes(candidateBytes),
  }
  let warning: string | undefined
  // 两件事各自尝试：meta 供撤销/清理，index 供 rail/版本列表；
  // 任一失败都不能回滚已经写成功的用户内容，只作为提示返回。
  try {
    await writeMeta(editDir, appliedMeta)
  } catch (err) {
    warning = err instanceof Error ? err.message : '写入编辑记录失败'
  }
  try {
    await appendIndex(root, appliedMeta)
  } catch (err) {
    warning = warning ?? (err instanceof Error ? err.message : '写入编辑索引失败')
  }

  try {
    opts.registerFile?.({
      editId,
      sessionKey: meta.sessionKey,
      path: meta.path,
      absPath: target.abs,
      action: meta.action,
      bytes: candidateBytes.byteLength,
      ...(meta.derivedFrom ? { derivedFrom: meta.derivedFrom } : {}),
    })
  } catch {
    // 登记失败只影响「全部」作用域，不影响这次应用
  }

  return {
    ok: true,
    editId,
    versionId: `local:${editId}`,
    appliedAt,
    backupPath: toRelPosix(root, path.join(editDir, meta.beforeFile)),
    ...(warning ? { warning } : {}),
  }
}

export async function discardEdit(opts: {
  workspaceDir: string
  editId: unknown
}): Promise<{ ok: true } | ArtifactEditFailure> {
  const editId = normalizeEditId(opts.editId)
  if (!editId) return fail('editId 非法', 'invalid-scope')
  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.workspaceDir))
  } catch {
    return fail('工作区不可用')
  }
  const editDir = editDirFor(root, editId)
  const meta = await readMeta(editDir)
  if (!meta) return fail('编辑记录不存在', 'not-found')
  if (meta.status !== 'proposed') return fail('该编辑已应用或已取消', 'invalid-scope')
  await fs.rm(path.join(editDir, meta.candidateFile), { force: true })
  await writeMeta(editDir, { ...meta, status: 'discarded' })
  return { ok: true }
}

/** 撤销最近一次应用：要求当前内容仍等于该次编辑的结果，否则拒绝 */
export async function undoEdit(opts: {
  workspaceDir: string
  editId: unknown
  registerFile?: (info: AppliedEditInfo) => void
}): Promise<ArtifactEditUndoResult | ArtifactEditFailure> {
  const editId = normalizeEditId(opts.editId)
  if (!editId) return fail('editId 非法', 'invalid-scope')
  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.workspaceDir))
  } catch {
    return fail('工作区不可用')
  }
  const meta = await readMeta(editDirFor(root, editId))
  if (!meta) return fail('编辑记录不存在', 'not-found')
  if (meta.status !== 'applied' || !meta.candidateHash) {
    return fail('该编辑尚未应用，无法撤销', 'invalid-scope')
  }

  const target = await resolveEditTarget(root, meta.path)
  if (!target) return fail('目标文件不存在或不在工作区内', 'invalid-path')

  const currentBytes = await fs.readFile(target.abs)
  if (sha256Bytes(currentBytes) !== meta.candidateHash) {
    return fail('文件在编辑后又被修改，不能自动撤销', 'conflict')
  }

  let beforeBytes: Buffer
  try {
    beforeBytes = await fs.readFile(path.join(editDirFor(root, editId), meta.beforeFile))
  } catch {
    return fail('改前内容已清理，无法撤销', 'unavailable')
  }

  const proposal = await stageEdit({
    target,
    sessionKey: meta.sessionKey,
    action: 'undo',
    scope: meta.scope,
    instruction: `undo ${editId}`,
    beforeBytes: currentBytes,
    candidateBytes: beforeBytes,
  })
  if (!proposal.ok) return proposal

  const applied = await applyEdit({
    workspaceDir: root,
    editId: proposal.editId,
    ...(opts.registerFile ? { registerFile: opts.registerFile } : {}),
  })
  if (!applied.ok) return applied
  return { ...applied, sourceEditId: editId }
}

interface IndexEntry {
  editId: string
  sessionKey: string | null
  path: string
  action: ArtifactEditAction
  scope: ArtifactEditScope
  at: number
  appliedAt?: number
  bytes: number
  derivedFrom?: string
}

/** 读索引并按 editId 取最后一条（同一编辑的合并保存会追加多行） */
async function readIndexEntries(root: string): Promise<Map<string, IndexEntry>> {
  let text: string
  try {
    text = await fs.readFile(indexPathFor(root), 'utf8')
  } catch {
    return new Map()
  }
  const byId = new Map<string, IndexEntry>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = JSON.parse(trimmed) as IndexEntry
      if (!entry || typeof entry.editId !== 'string' || typeof entry.path !== 'string') continue
      byId.set(entry.editId, entry)
    } catch {
      // 坏行跳过
    }
  }
  return byId
}

export interface LocalEditContent {
  editId: string
  relPath: string
  absPath: string
  bytes: number
  /** null = 二进制/非文本（版本 diff 不处理） */
  text: string | null
}

/** 读某次本地编辑的候选/改前内容（版本对照用） */
export async function getLocalEditContent(opts: {
  workspaceDir: string
  editId: unknown
  which?: 'candidate' | 'before'
}): Promise<LocalEditContent | null> {
  const editId = normalizeEditId(opts.editId)
  if (!editId) return null
  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.workspaceDir))
  } catch {
    return null
  }
  const dir = editDirFor(root, editId)
  const meta = await readMeta(dir)
  if (!meta) return null
  const file = opts.which === 'before' ? meta.beforeFile : meta.candidateFile
  const abs = path.join(dir, file)
  try {
    const stat = await fs.lstat(abs)
    if (!stat.isFile()) return null
    const bytes = await fs.readFile(abs)
    const text =
      isTextArtifactPath(meta.path) && !bytes.includes(0) ? bytes.toString('utf8') : null
    return { editId, relPath: meta.path, absPath: abs, bytes: stat.size, text }
  } catch {
    return null
  }
}

/**
 * 手工保存（`file:write` 完成后）记录一条 local 版本。
 * 同一文件 60s 内的连续保存合并为同一条：candidate 更新，before 保留最早。
 */
export async function recordManualSave(opts: {
  workspaceDir: string
  path: unknown
  beforeContent: string
  afterContent: string
  sessionKey?: string | null
  now?: number
}): Promise<{ editId: string; merged: boolean; path: string; bytes: number } | null> {
  const { beforeContent, afterContent } = opts
  if (typeof opts.path !== 'string' || !opts.path) return null
  if (beforeContent === afterContent) return null
  if (beforeContent.includes('\0') || afterContent.includes('\0')) return null
  if (
    Buffer.byteLength(beforeContent, 'utf8') > MAX_TEXT_EDIT_BYTES ||
    Buffer.byteLength(afterContent, 'utf8') > MAX_TEXT_EDIT_BYTES
  ) {
    return null
  }

  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.workspaceDir))
  } catch {
    return null
  }

  const raw = opts.path
  let rel: string
  let abs: string
  if (path.isAbsolute(raw)) {
    abs = path.resolve(raw)
    if (!inside(root, abs)) return null
    rel = toRelPosix(root, abs)
  } else {
    const normalized = normalizeArtifactPath(raw)
    if (!normalized) return null
    rel = normalized
    abs = path.join(root, ...rel.split('/'))
  }
  const role = classifyArtifact({ path: rel })
  if (role === 'internal' || role === 'ephemeral' || !isTextArtifactPath(rel)) return null
  try {
    const real = await fs.realpath(abs)
    if (!inside(root, real)) return null
  } catch {
    return null
  }

  const sessionKey = normalizeSessionKey(opts.sessionKey)
  const now = opts.now ?? Date.now()
  const entries = await readIndexEntries(root)
  const latest = [...entries.values()]
    .filter((entry) => entry.path === rel && (entry.sessionKey ?? null) === sessionKey)
    .sort((a, b) => (b.appliedAt ?? b.at) - (a.appliedAt ?? a.at))[0]

  if (
    latest &&
    latest.action === 'manual' &&
    now - (latest.appliedAt ?? latest.at) <= MANUAL_MERGE_MS
  ) {
    const dir = editDirFor(root, latest.editId)
    const meta = await readMeta(dir)
    if (meta && meta.status === 'applied') {
      const candidateBytes = Buffer.from(afterContent, 'utf8')
      try {
        await fs.writeFile(path.join(dir, meta.candidateFile), candidateBytes)
        const updated: EditMeta = {
          ...meta,
          candidateHash: sha256Bytes(candidateBytes),
          appliedAt: now,
        }
        await writeMeta(dir, updated)
        await appendIndex(root, updated)
        return {
          editId: latest.editId,
          merged: true,
          path: rel,
          bytes: candidateBytes.byteLength,
        }
      } catch {
        // 合并失败就落一条新的，不能让保存没有版本
      }
    }
  }

  const editId = newEditId()
  const dir = editDirFor(root, editId)
  const ext = path.extname(rel) || '.txt'
  const beforeFile = `before${ext}`
  const candidateFile = `candidate${ext}`
  const beforeBytes = Buffer.from(beforeContent, 'utf8')
  const candidateBytes = Buffer.from(afterContent, 'utf8')
  const meta: EditMeta = {
    editId,
    sessionKey,
    path: rel,
    action: 'manual',
    scope: { type: 'file' },
    at: now,
    status: 'applied',
    baseHash: sha256Bytes(beforeBytes),
    candidateHash: sha256Bytes(candidateBytes),
    beforeFile,
    candidateFile,
    originalBytes: beforeBytes.byteLength,
    appliedAt: now,
  }
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, beforeFile), beforeBytes)
    await fs.writeFile(path.join(dir, candidateFile), candidateBytes)
    await writeMeta(dir, meta)
    await appendIndex(root, meta)
    return { editId, merged: false, path: rel, bytes: candidateBytes.byteLength }
  } catch {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    return null
  }
}

export async function listEdits(opts: {
  workspaceDir: string
  sessionKey?: string | null
  limit?: number
}): Promise<ArtifactEditListResult | ArtifactEditFailure> {
  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.workspaceDir))
  } catch {
    return fail('工作区不可用')
  }
  const sessionFilter =
    typeof opts.sessionKey === 'string' && opts.sessionKey.trim().length > 0
      ? normalizeSessionKey(opts.sessionKey)
      : null
  if (typeof opts.sessionKey === 'string' && opts.sessionKey.trim().length > 0 && !sessionFilter) {
    return fail('sessionKey 非法', 'invalid-scope')
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const byId = await readIndexEntries(root)

  const edits: LocalArtifactEdit[] = []
  for (const entry of byId.values()) {
    if (sessionFilter && entry.sessionKey !== null && entry.sessionKey !== sessionFilter) continue
    edits.push({
      editId: entry.editId,
      sessionKey: entry.sessionKey ?? null,
      path: entry.path,
      action: entry.action,
      scope: entry.scope,
      at: entry.appliedAt ?? entry.at,
      bytes: entry.bytes,
      ...(entry.derivedFrom ? { derivedFrom: entry.derivedFrom } : {}),
    })
  }
  edits.sort((a, b) => b.at - a.at)
  return { ok: true, edits: edits.slice(0, limit) }
}

async function dirSize(dir: string, names: readonly string[]): Promise<number> {
  let total = 0
  for (const name of names) {
    try {
      const stat = await fs.stat(path.join(dir, name))
      if (stat.isFile()) total += stat.size
    } catch {
      // 文件被清理
    }
  }
  return total
}

/** 每日清理：未应用候选 24h；已应用内容按 30 天 / 1GB 上限（保留 meta） */
export async function pruneEditStore(opts: {
  workspaceDir: string
  now?: number
  maxAgeDays?: number
  maxBytes?: number
}): Promise<{ removedDirs: number; prunedContents: number; freedBytes: number }> {
  const now = opts.now ?? Date.now()
  const maxAgeMs = (opts.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000
  const maxBytes = opts.maxBytes ?? 1024 * 1024 * 1024
  const root = path.resolve(opts.workspaceDir)
  const editsDir = path.join(root, ...EDIT_DIR.split('/'))

  let entries: Dirent[]
  try {
    entries = await fs.readdir(editsDir, { withFileTypes: true })
  } catch {
    return { removedDirs: 0, prunedContents: 0, freedBytes: 0 }
  }

  let removedDirs = 0
  let prunedContents = 0
  let freedBytes = 0
  const applied: Array<{ dir: string; meta: EditMeta; bytes: number }> = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(editsDir, entry.name)
    const meta = await readMeta(dir)
    if (!meta) continue
    if (meta.status !== 'applied') {
      if (now - meta.at >= STALE_PROPOSAL_MS) {
        await fs.rm(dir, { recursive: true, force: true })
        removedDirs += 1
      }
      continue
    }
    applied.push({
      dir,
      meta,
      bytes: await dirSize(dir, [meta.beforeFile, meta.candidateFile]),
    })
  }

  let total = applied.reduce((sum, item) => sum + item.bytes, 0)
  applied.sort((a, b) => a.meta.at - b.meta.at)
  for (const item of applied) {
    const tooOld = now - item.meta.at > maxAgeMs
    if (!tooOld && total <= maxBytes) continue
    if (item.meta.contentPruned) continue
    await fs.rm(path.join(item.dir, item.meta.beforeFile), { force: true })
    await fs.rm(path.join(item.dir, item.meta.candidateFile), { force: true })
    await writeMeta(item.dir, { ...item.meta, contentPruned: true })
    total -= item.bytes
    prunedContents += 1
    freedBytes += item.bytes
  }

  return { removedDirs, prunedContents, freedBytes }
}

/** 清 `.lumii/tmp` 与 `.lumii/exports` 里超过 24h 的临时目录（去重 journal 先由调用方处理） */
export async function pruneWorkspaceScratch(opts: {
  workspaceDir: string
  now?: number
  maxAgeHours?: number
}): Promise<{ removed: number }> {
  const now = opts.now ?? Date.now()
  const cutoff = (opts.maxAgeHours ?? 24) * 60 * 60 * 1000
  const root = path.resolve(opts.workspaceDir)
  let removed = 0
  for (const rel of ['.lumii/tmp', '.lumii/exports']) {
    const dir = path.join(root, ...rel.split('/'))
    let children: Dirent[]
    try {
      children = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      const abs = path.join(dir, child.name)
      try {
        const stat = await fs.lstat(abs)
        if (stat.isSymbolicLink()) continue
        if (now - stat.mtimeMs < cutoff) continue
        await fs.rm(abs, { recursive: true, force: true })
        removed += 1
      } catch {
        // 被占用/已删除：下次再试
      }
    }
  }
  return { removed }
}
