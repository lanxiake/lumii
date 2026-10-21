import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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
