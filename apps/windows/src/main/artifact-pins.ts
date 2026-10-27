/**
 * 「以此为准」固化（P2 T6）
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §4.5
 *
 * 固化 = **立即复制内容**到 `<ws>/.lumii/pins/<pinId>/<basename>`，索引写
 * `<ws>/.lumii/pins/index.json`。同一 `(sessionKey, path)` 只保留一个选定；
 * 新选定替换旧索引项，旧文件留到清理（不自动删）。
 *
 * 单文件 ≤200MB；总量软上限 2GB，超过时**拒绝新增**并提示清理。
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { normalizeArtifactPath } from '../shared/artifact-declaration'
import type {
  ArtifactPinFailure,
  ArtifactPinListResult,
  ArtifactPinResult,
  PinEntryInfo,
} from '../shared/artifact-pin-types'

const PIN_DIR = '.lumii/pins'
const INDEX_FILE = 'index.json'

export const MAX_PIN_BYTES = 200 * 1024 * 1024
export const MAX_PIN_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

function fail(error: string, code: ArtifactPinFailure['code'] = 'unavailable'): ArtifactPinFailure {
  return { ok: false, error, code }
}

function pinRoot(root: string): string {
  return path.join(root, ...PIN_DIR.split('/'))
}

function indexPath(root: string): string {
  return path.join(pinRoot(root), INDEX_FILE)
}

function newPinId(): string {
  return `pin-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function sanitizeEntry(raw: unknown): PinEntryInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const pinId = typeof input.pinId === 'string' ? input.pinId : ''
  const rawPath = typeof input.path === 'string' ? normalizeArtifactPath(input.path) : null
  const versionId = typeof input.versionId === 'string' ? input.versionId : ''
  const bytes = typeof input.bytes === 'number' && Number.isFinite(input.bytes) ? input.bytes : 0
  const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : 0
  const sessionKey =
    typeof input.sessionKey === 'string' && input.sessionKey.trim()
      ? input.sessionKey
      : null
  if (!pinId || !rawPath || !versionId) return null
  return { pinId, sessionKey, path: rawPath, versionId, bytes, at }
}

export async function readPinIndex(root: string): Promise<PinEntryInfo[]> {
  try {
    const text = await fs.readFile(indexPath(root), 'utf8')
    const parsed = JSON.parse(text) as { pins?: unknown }
    if (!Array.isArray(parsed?.pins)) return []
    return parsed.pins
      .map(sanitizeEntry)
      .filter((entry): entry is PinEntryInfo => entry !== null)
  } catch {
    return []
  }
}

/** 索引原子写：临时文件 + rename */
async function writePinIndex(root: string, pins: readonly PinEntryInfo[]): Promise<void> {
  const file = indexPath(root)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify({ pins }, null, 0), 'utf8')
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export interface PinLimits {
  maxFileBytes?: number
  maxTotalBytes?: number
}

/** 某路径/版本是否已固化（内容解析与历史合并用） */
export async function findPinEntry(opts: {
  workspaceDir: string
  path: string
  versionId: string
}): Promise<PinEntryInfo | undefined> {
  const rel = normalizeArtifactPath(opts.path)
  if (!rel) return undefined
  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.workspaceDir))
  } catch {
    return undefined
  }
  const pins = await readPinIndex(root)
  return pins.find((entry) => entry.path === rel && entry.versionId === opts.versionId)
}

/** 固化文件绝对路径：`<ws>/.lumii/pins/<pinId>/<basename>` */
export function pinFilePath(workspaceDir: string, entry: PinEntryInfo): string {
  const base = entry.path.split('/').pop() ?? 'artifact.bin'
  return path.join(path.resolve(workspaceDir), ...PIN_DIR.split('/'), entry.pinId, base)
}

export async function listPins(opts: {
  workspaceDir: string
  sessionKey?: string | null
  path?: string
  limits?: PinLimits
}): Promise<ArtifactPinListResult> {
  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.workspaceDir))
  } catch {
    return fail('工作区不可用')
  }
  if (opts.path !== undefined) {
    const rel = normalizeArtifactPath(opts.path)
    if (!rel) return fail('路径非法', 'invalid-path')
  }
  const rel = opts.path !== undefined ? normalizeArtifactPath(opts.path) : null
  const session =
    typeof opts.sessionKey === 'string' && opts.sessionKey.trim() ? opts.sessionKey : null
  const all = await readPinIndex(root)
  const pins = all.filter(
    (entry) =>
      (session === null || entry.sessionKey === null || entry.sessionKey === session) &&
      (rel === null || entry.path === rel),
  )
  return {
    ok: true,
    pins,
    totalBytes: pins.reduce((sum, entry) => sum + entry.bytes, 0),
    limitBytes: opts.limits?.maxTotalBytes ?? MAX_PIN_TOTAL_BYTES,
  }
}

/**
 * 固化一版：调用方已经解析好内容字节（文本或二进制都适用）。
 *
 * 同一 `(sessionKey, path)` 只保留一个选定：旧索引项被移除（文件留到清理）。
 */
export async function pinVersion(opts: {
  workspaceDir: string
  sessionKey?: string | null
  path: string
  versionId: string
  content: Buffer
  limits?: PinLimits
}): Promise<ArtifactPinResult | ArtifactPinFailure> {
  const rel = normalizeArtifactPath(opts.path)
  if (!rel) return fail('路径非法', 'invalid-path')
  if (typeof opts.versionId !== 'string' || !opts.versionId) {
    return fail('版本标识非法', 'invalid-scope')
  }
  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.workspaceDir))
  } catch {
    return fail('工作区不可用')
  }
  if (!Buffer.isBuffer(opts.content) || opts.content.byteLength === 0) {
    return fail('该版本没有可固化的内容')
  }
  const maxFileBytes = opts.limits?.maxFileBytes ?? MAX_PIN_BYTES
  if (opts.content.byteLength > maxFileBytes) {
    return fail(`文件太大（超过 ${Math.round(maxFileBytes / 1024 / 1024)}MB），无法固化`)
  }

  const sessionKey =
    typeof opts.sessionKey === 'string' && opts.sessionKey.trim() ? opts.sessionKey : null
  const pins = await readPinIndex(root)
  const maxTotalBytes = opts.limits?.maxTotalBytes ?? MAX_PIN_TOTAL_BYTES
  const existing = pins.find(
    (entry) => entry.path === rel && entry.sessionKey === sessionKey,
  )
  const keptTotal = pins
    .filter((entry) => entry !== existing)
    .reduce((sum, entry) => sum + entry.bytes, 0)
  if (keptTotal + opts.content.byteLength > maxTotalBytes) {
    return fail(
      `已固化版本占用将超过 ${Math.round(maxTotalBytes / 1024 / 1024 / 1024)}GB 上限，请先在设置里清理`,
    )
  }

  const pinId = newPinId()
  const base = rel.split('/').pop() ?? 'artifact.bin'
  if (!base || base.startsWith('.') || base.includes('\0')) {
    return fail('文件名非法', 'invalid-path')
  }
  const dir = path.join(pinRoot(root), pinId)
  const absFile = path.join(dir, base)
  if (!inside(path.join(pinRoot(root)), dir)) return fail('路径越界', 'invalid-path')

  try {
    await fs.mkdir(dir, { recursive: true })
    const tmp = `${absFile}.${randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(tmp, opts.content)
    await fs.rename(tmp, absFile)
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    return fail(err instanceof Error ? err.message : '写入固化副本失败')
  }

  const entry: PinEntryInfo = {
    pinId,
    sessionKey,
    path: rel,
    versionId: opts.versionId,
    bytes: opts.content.byteLength,
    at: Date.now(),
  }
  const next = [...pins.filter((item) => item !== existing), entry]
  try {
    await writePinIndex(root, next)
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    return fail(err instanceof Error ? err.message : '写入固化索引失败')
  }

  return {
    ok: true,
    pinId,
    bytes: entry.bytes,
    ...(existing ? { replaced: existing.pinId } : {}),
  }
}

/** 取消选定：只删索引项，文件留到清理 */
export async function unpinVersion(opts: {
  workspaceDir: string
  pinId: string
}): Promise<{ ok: true } | ArtifactPinFailure> {
  if (typeof opts.pinId !== 'string' || !opts.pinId) return fail('pinId 非法', 'invalid-scope')
  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.workspaceDir))
  } catch {
    return fail('工作区不可用')
  }
  const pins = await readPinIndex(root)
  const next = pins.filter((entry) => entry.pinId !== opts.pinId)
  if (next.length === pins.length) return fail('找不到这个固化版本', 'not-found')
  try {
    await writePinIndex(root, next)
  } catch (err) {
    return fail(err instanceof Error ? err.message : '写入固化索引失败')
  }
  return { ok: true }
}

/** 清空固化（用户显式操作；只由设置页调用） */
export async function clearPins(opts: {
  workspaceDir: string
}): Promise<{ ok: true; removed: number; freedBytes: number } | ArtifactPinFailure> {
  let root: string
  try {
    root = await fs.realpath(path.resolve(opts.workspaceDir))
  } catch {
    return fail('工作区不可用')
  }
  const pins = await readPinIndex(root)
  const freedBytes = pins.reduce((sum, entry) => sum + entry.bytes, 0)
  try {
    await fs.rm(pinRoot(root), { recursive: true, force: true })
  } catch (err) {
    return fail(err instanceof Error ? err.message : '清理固化副本失败')
  }
  return { ok: true, removed: pins.length, freedBytes }
}
