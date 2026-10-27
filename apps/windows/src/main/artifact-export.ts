/**
 * 产物导出（主进程）
 *
 * 渲染层只给工作区相对路径 + 目标位置，文件读写全在主进程：
 * 大文件不进 renderer，也不让 UI 线程参与压缩。
 *
 * 两种模式：
 * - `zip`：保留相对目录结构打进一个 zip（同名不同目录不会互相覆盖）；
 * - `copy`：拷到目标目录的**同一层**，重名自动加 ` (2)` 后缀（用户拿去做附件/发人）。
 *
 * 安全闸与缩略图同源：`normalizeArtifactPath`（拒绝绝对路径/盘符/`..`）→
 * `realpath` 后再判是否仍在工作区内 → 只接受普通文件（符号链接、目录、junction 一律拒）。
 */

import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import JSZip from 'jszip'
import { normalizeArtifactPath } from '../shared/artifact-declaration'
import type { ArtifactExportResult } from '../shared/artifact-export-types'

/** 单次导出的源文件总量上限；超过提示分批（压缩包本身还会再占同样空间） */
export const MAX_EXPORT_BYTES = 500 * 1024 * 1024
/** 一次最多导出的文件数（与台账渲染上限同量级，避免误传整个工作区） */
export const MAX_EXPORT_FILES = 500

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export interface ResolvedExportFile {
  rel: string
  abs: string
  bytes: number
}

/**
 * 把渲染层给的路径解析成可导出的文件列表；任何一个不合规就整体失败——
 * 半成功最难解释（用户以为都导了）。
 */
export async function resolveExportFiles(
  workspaceDir: string,
  relPaths: readonly unknown[],
): Promise<{ ok: true; files: ResolvedExportFile[] } | { ok: false; error: string }> {
  if (!Array.isArray(relPaths) || relPaths.length === 0) {
    return { ok: false, error: '没有要导出的文件' }
  }
  let root: string
  try {
    root = await fs.realpath(path.resolve(workspaceDir))
  } catch {
    return { ok: false, error: '工作区不可用' }
  }

  const seen = new Set<string>()
  const files: ResolvedExportFile[] = []
  let total = 0

  for (const raw of relPaths) {
    if (typeof raw !== 'string') return { ok: false, error: '路径必须是字符串' }
    const rel = normalizeArtifactPath(raw)
    if (!rel) return { ok: false, error: `路径不合法：${raw}` }
    if (seen.has(rel)) continue
    seen.add(rel)
    if (files.length >= MAX_EXPORT_FILES) {
      return { ok: false, error: `一次最多导出 ${MAX_EXPORT_FILES} 个文件` }
    }

    const abs = path.join(root, ...rel.split('/'))
    if (!inside(root, abs)) return { ok: false, error: `路径越界：${rel}` }
    let stat
    try {
      stat = await fs.lstat(abs)
    } catch {
      return { ok: false, error: `文件不存在：${rel}` }
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, error: `不是普通文件：${rel}` }
    }
    let real: string
    try {
      real = await fs.realpath(abs)
    } catch {
      return { ok: false, error: `文件不可读：${rel}` }
    }
    if (!inside(root, real)) return { ok: false, error: `路径越界：${rel}` }

    total += stat.size
    if (total > MAX_EXPORT_BYTES) {
      return { ok: false, error: '总大小超过 500MB，请分批导出' }
    }
    files.push({ rel, abs, bytes: stat.size })
  }

  return { ok: true, files }
}

/** 目标目录里不冲突的文件名：`a.png` → `a (2).png` */
async function uniqueName(dir: string, name: string, taken: Set<string>): Promise<string> {
  const ext = path.extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? name : `${base} (${index})${ext}`
    if (taken.has(candidate)) continue
    try {
      await fs.access(path.join(dir, candidate))
    } catch {
      taken.add(candidate)
      return candidate
    }
  }
  const fallback = `${base} (${Date.now()})${ext}`
  taken.add(fallback)
  return fallback
}

/** zip 先写临时文件再改名：中途失败不留半个包 */
async function writeZip(files: readonly ResolvedExportFile[], destPath: string): Promise<void> {
  const zip = new JSZip()
  for (const file of files) zip.file(file.rel, await fs.readFile(file.abs))
  const tmp = `${destPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await new Promise<void>((resolve, reject) => {
      const stream = zip.generateNodeStream({
        type: 'nodebuffer',
        streamFiles: true,
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      })
      const out = createWriteStream(tmp)
      stream.on('error', reject)
      out.on('error', reject)
      out.on('finish', resolve)
      stream.pipe(out)
    })
    await fs.rename(tmp, destPath)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export async function exportArtifacts(opts: {
  workspaceDir: string
  relPaths: readonly unknown[]
  mode: 'zip' | 'copy' | 'save'
  /** 用户选定的目标路径（zip/save 是文件路径，copy 是目录） */
  destPath: string
}): Promise<ArtifactExportResult> {
  const resolved = await resolveExportFiles(opts.workspaceDir, opts.relPaths)
  if (!resolved.ok) return { ok: false, exported: 0, bytes: 0, error: resolved.error }
  const { files } = resolved
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0)

  try {
    if (opts.mode === 'zip') {
      await fs.mkdir(path.dirname(opts.destPath), { recursive: true })
      await writeZip(files, opts.destPath)
      return { ok: true, exported: files.length, bytes, destPath: opts.destPath }
    }

    // 另存为：单文件直拷到用户选的路径（动作条「导出 ▾ → 另存为」）
    if (opts.mode === 'save') {
      if (files.length !== 1) return { ok: false, exported: 0, bytes: 0, error: '另存为只支持单个文件' }
      await fs.mkdir(path.dirname(opts.destPath), { recursive: true })
      await fs.copyFile(files[0]!.abs, opts.destPath)
      return { ok: true, exported: 1, bytes, destPath: opts.destPath }
    }

    await fs.mkdir(opts.destPath, { recursive: true })
    const taken = new Set<string>()
    let exported = 0
    for (const file of files) {
      const name = await uniqueName(opts.destPath, path.posix.basename(file.rel), taken)
      await fs.copyFile(file.abs, path.join(opts.destPath, name))
      exported += 1
    }
    return { ok: true, exported, bytes, destPath: opts.destPath }
  } catch (err) {
    return {
      ok: false,
      exported: 0,
      bytes: 0,
      error: err instanceof Error ? err.message : '导出失败',
    }
  }
}
