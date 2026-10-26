/**
 * 产物缩略图服务（P1）
 *
 * - 图片：sharp 缩到 256px webp；
 * - 视频：ffmpeg 抽首帧（0.5s）成 jpg；
 * - PPTX：jszip 数页数（不做首页渲染，P2 再接）；
 * - 缓存按「路径 + mtime + size + 首 64KB」hash，命中直接返回；
 * - 并发上限 2、同 key 复用飞行中的 Promise、失败 60s 负缓存、LRU 500MB。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import sharp from 'sharp'
import JSZip from 'jszip'
import { runFfmpeg } from './ffmpeg-runner'
import { buildLocalMediaUrl } from './local-media-protocol'
import { classifyArtifact, kindOf } from '../shared/artifact-rules'
import { normalizeArtifactPath } from '../shared/artifact-declaration'
import type { ArtifactThumbResult } from '../shared/artifact-thumbs-types'

const THUMB_MAX_EDGE = 256
const CACHE_MAX_BYTES = 500 * 1024 * 1024
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_PPTX_BYTES = 300 * 1024 * 1024
/** 单次生成的上界：sharp 遇到畸形图可能不返回，槽位只有 2 个，卡住就整条 rail 不动 */
const JOB_TIMEOUT_MS = 60_000
/** 失败结果短暂记住：折叠组收起/展开会重新挂载卡片，否则坏文件每次都重跑一遍 ffmpeg */
const FAILURE_TTL_MS = 60_000

let active = 0
const waiters: Array<() => void> = []
const inflight = new Map<string, Promise<ArtifactThumbResult>>()
const failures = new Map<string, { at: number; result: ArtifactThumbResult }>()
const pagesCache = new Map<string, number>()

/**
 * 并发槽。超时按「放弃等待」算：底层 promise 可能永远不回来（畸形图让 sharp 空转），
 * 但槽必须还回去，否则 2 个槽全卡死后整条 rail 静默停在占位。
 */
async function withSlot<T>(job: () => Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  while (active >= 2) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  active += 1
  try {
    return await Promise.race([
      job(),
      new Promise<T>((resolve) => {
        setTimeout(() => resolve(onTimeout()), ms).unref?.()
      }),
    ])
  } finally {
    active -= 1
    waiters.shift()?.()
  }
}

function cacheDirOf(workspaceDir: string): string {
  return path.join(workspaceDir, '.lumii', 'cache', 'thumbs')
}

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

const KEY_HEAD_BYTES = 64 * 1024

function cacheKey(relPath: string, mtimeMs: number, size: number, head: Buffer): string {
  return createHash('sha1')
    .update(`${relPath.replace(/\\/g, '/')}|${mtimeMs}|${Math.round(size)}|`)
    .update(head)
    .digest('hex')
}

/**
 * 首 64KB 进 key：exFAT/网络盘的 mtime 粒度是 2s，同尺寸重写会沿用旧 key，
 * 用户就会看到上一版的图。读失败（权限/被占用）退回纯 stat，最差不优于原方案。
 */
async function readHead(abs: string): Promise<Buffer> {
  let handle: import('node:fs/promises').FileHandle | undefined
  try {
    handle = await fs.open(abs, 'r')
    const buf = Buffer.alloc(KEY_HEAD_BYTES)
    const { bytesRead } = await handle.read(buf, 0, KEY_HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return Buffer.alloc(0)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function ensureImageThumb(abs: string, out: string): Promise<{ width?: number; height?: number }> {
  const info = await sharp(abs)
    .rotate()
    .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(out)
  return { width: info.width, height: info.height }
}

async function extractVideoFrame(abs: string, out: string): Promise<boolean> {
  // 0.5s 处取帧：纯黑/片头空白时比第 0 帧更可能有内容
  const result = await runFfmpeg(
    [
      '-y',
      '-ss',
      '0.5',
      '-i',
      abs,
      '-frames:v',
      '1',
      '-vf',
      `scale=${THUMB_MAX_EDGE}:-2`,
      out,
    ],
    // 本地抽一帧正常是百毫秒级；30s 还没完说明文件坏了，别占着并发槽
    { timeoutMs: 30_000 },
  )
  return result.ok
}

/** 数不清（不是 zip / 过大）返回 null：0 会被卡片显示成「0 页」，骗用户文件是空的 */
async function countSlides(abs: string): Promise<number | null> {
  const stat = await fs.stat(abs)
  if (stat.size > MAX_PPTX_BYTES) return null
  const zip = await JSZip.loadAsync(await fs.readFile(abs))
  let pages = 0
  for (const name of Object.keys(zip.files)) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) pages += 1
  }
  return pages
}

/**
 * 临时文件名每次唯一：主进程超时会放弃等待，但底层 job 可能还在写 ——
 * 两次用同一个 tmp 路径会互相截断，最终 rename 出一个坏文件。
 * 扩展名必须留在最后，ffmpeg / sharp 都靠它推断容器格式。
 */
function tmpNameFor(out: string): string {
  const ext = path.extname(out)
  return `${out.slice(0, -ext.length)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp${ext}`
}

async function generate(
  workspaceDir: string,
  relPath: string,
  abs: string,
  key: string,
  kind: ReturnType<typeof kindOf>,
  stat: { size: number; mtimeMs: number },
): Promise<ArtifactThumbResult> {
  if (stat.size > MAX_SOURCE_BYTES) return { ok: false, error: '文件过大' }
  const dir = cacheDirOf(workspaceDir)
  await fs.mkdir(dir, { recursive: true })

  if (kind === 'slides') {
    const cachedPages = pagesCache.get(key)
    if (cachedPages !== undefined) {
      return { ok: true, meta: { pages: cachedPages }, fromCache: true }
    }
    const pages = await countSlides(abs)
    if (pages === null) return { ok: false, error: 'PPTX 过大或结构无法解析' }
    // 无界 Map 会随会话越积越多；页数重算成本很低，满 500 条就整体丢掉
    if (pagesCache.size >= 500) pagesCache.clear()
    pagesCache.set(key, pages)
    return { ok: true, meta: { pages }, fromCache: false }
  }

  if (kind === 'video') {
    const out = path.join(dir, `${key}.jpg`)
    try {
      const cached = await fs.stat(out)
      if (cached.size > 0) return { ok: true, url: buildLocalMediaUrl(out), fromCache: true }
    } catch {
      // 未命中
    }
    // 先写临时文件再改名：ffmpeg 中途失败会留下半截 jpg，
    // 下次会被当成缓存命中，用户看到的是坏图。
    const tmp = tmpNameFor(out)
    const ok = await extractVideoFrame(abs, tmp)
    if (!ok) {
      await fs.rm(tmp, { force: true })
      return { ok: false, error: '抽帧失败' }
    }
    await fs.rename(tmp, out)
    return { ok: true, url: buildLocalMediaUrl(out), fromCache: false }
  }

  if (kind === 'image' || kind === 'image-set') {
    const out = path.join(dir, `${key}.webp`)
    try {
      const cached = await fs.stat(out)
      if (cached.size > 0) return { ok: true, url: buildLocalMediaUrl(out), fromCache: true }
    } catch {
      // 未命中
    }
    const tmp = tmpNameFor(out)
    let size: { width?: number; height?: number }
    try {
      size = await ensureImageThumb(abs, tmp)
    } catch (err) {
      await fs.rm(tmp, { force: true })
      throw err
    }
    await fs.rename(tmp, out)
    return { ok: true, url: buildLocalMediaUrl(out), meta: size, fromCache: false }
  }

  return { ok: false, error: '该类型没有缩略图' }
}

export async function getArtifactThumb(opts: {
  workspaceDir: string
  relPath: string
}): Promise<ArtifactThumbResult> {
  const normalized = normalizeArtifactPath(opts.relPath)
  if (!normalized) return { ok: false, error: '路径非法' }
  if (classifyArtifact({ path: normalized }) === 'internal') {
    return { ok: false, error: '内部文件不生成缩略图' }
  }
  const root = path.resolve(opts.workspaceDir)
  const abs = path.join(root, ...normalized.split('/'))
  if (!inside(root, abs)) return { ok: false, error: '路径越界' }

  const kind = kindOf(normalized)
  if (kind !== 'image' && kind !== 'image-set' && kind !== 'video' && kind !== 'slides') {
    return { ok: false, error: '该类型没有缩略图' }
  }

  let stat
  try {
    stat = await fs.lstat(abs)
  } catch {
    return { ok: false, error: '文件不存在' }
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, error: '不是普通文件' }
  // 上层目录可能是 junction / 软链接（Windows 下 lstat 叶子看不到）：
  // 用 realpath 确认最终落在工作区内，否则会给工作区外的文件生成缩略图。
  try {
    const real = await fs.realpath(abs)
    if (!inside(root, real)) return { ok: false, error: '路径越界' }
  } catch {
    return { ok: false, error: '文件不存在' }
  }

  const key = cacheKey(normalized, stat.mtimeMs, stat.size, await readHead(abs))
  const existing = inflight.get(key)
  if (existing) return existing
  const failed = failures.get(key)
  if (failed) {
    if (Date.now() - failed.at <= FAILURE_TTL_MS) return failed.result
    failures.delete(key)
  }

  const recordFailure = (result: ArtifactThumbResult): ArtifactThumbResult => {
    if (failures.size >= 500) failures.clear()
    failures.set(key, { at: Date.now(), result })
    return result
  }

  // 排队期间文件可能被改写：key 里的 mtime 就旧了，结果会落在永不再读的旧 key 上
  // （下一轮按新 stat 取新 key 重算），至多留一个垃圾缓存文件，由 LRU 回收 ——
  // 比在这里判「过期」然后让卡片停在占位强。
  const job = withSlot(
    () => generate(root, normalized, abs, key, kind, stat),
    JOB_TIMEOUT_MS,
    () => ({ ok: false, error: '生成超时' }) as ArtifactThumbResult,
  )
    .then((result) => {
      if (result.ok) {
        failures.delete(key)
        return result
      }
      return recordFailure(result)
    })
    .catch((err): ArtifactThumbResult =>
      recordFailure({
        ok: false,
        error: err instanceof Error ? err.message : '缩略图生成失败',
      }),
    )
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, job)
  return job
}

/** 按 mtime 从旧到新删到上限以内；供启动/每日清理调用 */
export async function pruneThumbCache(
  workspaceDir: string,
  maxBytes = CACHE_MAX_BYTES,
): Promise<{ removed: number; bytes: number }> {
  const dir = cacheDirOf(workspaceDir)
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { removed: 0, bytes: 0 }
  }
  const files: Array<{ abs: string; size: number; mtimeMs: number }> = []
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const abs = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(abs)
      files.push({ abs, size: stat.size, mtimeMs: stat.mtimeMs })
      total += stat.size
    } catch {
      // ignore
    }
  }
  if (total <= maxBytes) return { removed: 0, bytes: 0 }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let removed = 0
  let bytes = 0
  for (const file of files) {
    if (total <= maxBytes) break
    try {
      await fs.unlink(file.abs)
      total -= file.size
      bytes += file.size
      removed += 1
    } catch {
      // ignore
    }
  }
  return { removed, bytes }
}
