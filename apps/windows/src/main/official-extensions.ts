import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { PluginProgress } from './plugins/plugin-manager'

/**
 * 官方扩展同步：把随安装包分发的扩展同步到用户扩展目录。
 *
 * 为什么走「复制到 ~/.lumii/extensions」而不是直接加载 resources：
 * - 复用现有的外部扩展加载器（热重载、禁用表、删除、错误回滚全套都在）；
 * - 用户在设置页能看到、能禁用、能打开目录；
 * - 以后换成「从远端下载」时，落点不变，只是来源从 resources 变成网络。
 *
 * 覆盖策略：
 * - 目标目录不存在 → 安装；
 * - 目标目录带 `.official.json` 且 sha256 相同 → 跳过；
 * - 目标目录带 `.official.json` 但 sha256 不同 → 用新版本覆盖；
 * - 目标目录**没有** `.official.json` → 视为用户自己的扩展，不覆盖（记 error）。
 *
 * 这个模块刻意不 import electron：单测直接跑文件系统。
 */

export interface OfficialExtensionInfo {
  id: string
  version: string
  sha256: string
}

export interface OfficialExtensionSyncResult {
  installed: string[]
  skipped: string[]
  errors: string[]
}

const MARKER = '.official.json'
const BUILD_INFO = 'build-info.json'
const CATALOG = 'catalog.json'

/** `catalog.json` 的一项：安装包只带这份清单，代码按需下载 */
export interface OfficialCatalogEntry {
  id: string
  name: string
  description: string
  version: string
  /** GitHub Release 资产名 */
  asset: string
  sha256: string
}

/** 读官方扩展清单。文件缺失/损坏时返回空数组（开发模式下目录形式仍然可用）。 */
export function loadOfficialCatalog(sourceDir: string): OfficialCatalogEntry[] {
  try {
    const raw = JSON.parse(readFileSync(path.join(sourceDir, CATALOG), 'utf8')) as {
      extensions?: OfficialCatalogEntry[]
    }
    return Array.isArray(raw.extensions) ? raw.extensions.filter((e) => e?.id && e?.asset && e?.sha256) : []
  } catch {
    return []
  }
}

/** 用户目录里是否装了某个官方扩展（只看 main.js，够不够用由加载器判） */
export function isOfficialExtensionInstalled(extensionsDir: string, id: string): boolean {
  return existsSync(path.join(extensionsDir, id, 'main.js'))
}

/**
 * 按需安装：下载 `ext-<id>.js` → `<extensionsDir>/<id>/main.js`，再写 build-info 与 marker。
 *
 * `download` 由调用方注入（默认实现走 GitHub Release + 镜像测速），这样本模块
 * 不依赖 electron / 网络，单测可以直接喂字节。
 *
 * 覆盖策略与随包同步一致：目标目录没有 marker 时视为用户自己的扩展，拒绝覆盖。
 * 先下载到根目录的 `.staging-<id>.js` 再改名进目录 —— 外部加载器只扫**子目录**，
 * 下载中途不会被当成半截扩展加载。
 */
export async function installOfficialExtension(opts: {
  entry: OfficialCatalogEntry
  extensionsDir: string
  download: (destFile: string, onProgress: (p: PluginProgress) => void, signal?: AbortSignal) => Promise<void>
  onProgress: (p: PluginProgress) => void
  signal?: AbortSignal
}): Promise<{ dir: string }> {
  const { entry, extensionsDir, download, onProgress, signal } = opts
  const destDir = path.join(extensionsDir, entry.id)
  if (existsSync(destDir) && readMarker(destDir) === null) {
    throw new Error(`目录 ${entry.id} 已存在且不是官方扩展，拒绝覆盖`)
  }

  mkdirSync(extensionsDir, { recursive: true })
  const staging = path.join(extensionsDir, `.staging-${entry.id}.js`)
  try {
    await download(staging, onProgress, signal)
    onProgress({ phase: 'extracting' })
    if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
    mkdirSync(destDir, { recursive: true })
    renameSync(staging, path.join(destDir, 'main.js'))
    writeFileSync(
      path.join(destDir, BUILD_INFO),
      `${JSON.stringify({ id: entry.id, version: entry.version, sha256: entry.sha256 }, null, 2)}\n`,
      'utf8',
    )
    writeFileSync(
      path.join(destDir, MARKER),
      `${JSON.stringify({ ...entry, installedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    )
    onProgress({ phase: 'done' })
    return { dir: destDir }
  } finally {
    rmSync(staging, { force: true })
  }
}

/** 卸载：只删官方扩展（有 marker），用户自己的目录不动。 */
export function removeOfficialExtension(extensionsDir: string, id: string): boolean {
  const dir = path.join(extensionsDir, id)
  if (readMarker(dir) === null) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

function readInfo(dir: string): OfficialExtensionInfo | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, BUILD_INFO), 'utf8')) as Partial<OfficialExtensionInfo>
    if (!raw.id || !raw.sha256) return null
    return { id: raw.id, version: raw.version ?? '0.0.0', sha256: raw.sha256 }
  } catch {
    return null
  }
}

function readMarker(dir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, MARKER), 'utf8')) as { sha256?: string }
    return raw.sha256 ?? null
  } catch {
    return null
  }
}

/**
 * 同步 `sourceDir` 下的官方扩展到 `destDir`。
 *
 * 幂等：内容没变时只读文件，不碰用户目录。
 */
export function syncOfficialExtensions(
  sourceDir: string,
  destDir: string,
): OfficialExtensionSyncResult {
  const result: OfficialExtensionSyncResult = { installed: [], skipped: [], errors: [] }

  let dirs: string[]
  try {
    dirs = readdirSync(sourceDir)
  } catch {
    // 没有官方扩展（或构建产物未生成）：不是错误
    return result
  }

  mkdirSync(destDir, { recursive: true })

  for (const dirName of dirs) {
    const src = path.join(sourceDir, dirName)
    try {
      if (!statSync(src).isDirectory()) continue
      if (!existsSync(path.join(src, 'main.js'))) continue
    } catch {
      continue
    }

    const info = readInfo(src)
    if (!info) {
      result.errors.push(`${dirName}: 缺少或损坏的 ${BUILD_INFO}`)
      continue
    }

    const dest = path.join(destDir, info.id)
    const destExists = existsSync(dest)
    const markerSha = destExists ? readMarker(dest) : null

    if (destExists && markerSha === null) {
      result.errors.push(`${info.id}: 目标目录已存在且不是官方扩展，拒绝覆盖`)
      continue
    }
    if (markerSha === info.sha256) {
      result.skipped.push(info.id)
      continue
    }

    try {
      if (destExists) rmSync(dest, { recursive: true, force: true })
      cpSync(src, dest, { recursive: true })
      writeFileSync(
        path.join(dest, MARKER),
        `${JSON.stringify({ ...info, syncedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      )
      result.installed.push(info.id)
    } catch (err) {
      result.errors.push(`${info.id}: ${(err as Error).message}`)
    }
  }

  return result
}
