/**
 * 云同步目录复制工具：导出/导入共用。
 * 跳过 .git 等重目录，支持大文件阈值，单文件失败不阻断整树复制。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../logger'

const logger = createLogger('cloud-sync/copy')

/** outputs 同步单文件上限：超过则跳过（避免仓库膨胀与推送超时） */
export const SYNC_OUTPUTS_MAX_BYTES = 5 * 1024 * 1024

/**
 * 遍历复制时直接剪枝的目录名（与 workspace VCS 重目录策略对齐）。
 * 嵌套 git 仓库的 `.git` 在 Windows 上常触发 EPERM，绝不能进 sync 仓。
 */
export const SYNC_SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.mtbot-vcs',
  'node_modules',
  '.cache',
  'tmp',
  'temp',
])

export interface CopySyncDirectoryOptions {
  /** 超过该字节数的文件跳过；不设则不按大小过滤 */
  maxSize?: number
}

export interface CopySyncDirectoryResult {
  copied: number
  skippedLarge: number
  skippedDirs: number
  errors: string[]
}

/**
 * 判断目录项是否应跳过递归复制。
 */
export function shouldSkipSyncCopyDir(entryName: string): boolean {
  return SYNC_SKIP_DIR_NAMES.has(entryName)
}

/**
 * 递归复制目录；跳过 SYNC_SKIP_DIR_NAMES，按需跳过大文件，单文件 EPERM 等记入 errors 后继续。
 */
export function copySyncDirectory(
  src: string,
  dst: string,
  options?: CopySyncDirectoryOptions,
): CopySyncDirectoryResult {
  const result: CopySyncDirectoryResult = {
    copied: 0,
    skippedLarge: 0,
    skippedDirs: 0,
    errors: [],
  }

  if (!fs.existsSync(src)) return result

  if (!fs.existsSync(dst)) {
    fs.mkdirSync(dst, { recursive: true })
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(src, { withFileTypes: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`${src}: ${msg}`)
    logger.warn(`[copySyncDirectory] 无法读取目录: ${src} (${msg})`)
    return result
  }

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)

    if (entry.isDirectory()) {
      if (shouldSkipSyncCopyDir(entry.name)) {
        result.skippedDirs += 1
        logger.info(`[copySyncDirectory] 跳过目录: ${srcPath}`)
        // 清掉目标侧历史残留（例如上次误拷入的嵌套 .git），避免 sync 仓膨胀/推送超时
        if (fs.existsSync(dstPath)) {
          try {
            fs.rmSync(dstPath, { recursive: true, force: true })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            result.errors.push(`${dstPath}: 清理失败 ${msg}`)
            logger.warn(`[copySyncDirectory] 清理残留目录失败: ${dstPath} (${msg})`)
          }
        }
        continue
      }
      const nested = copySyncDirectory(srcPath, dstPath, options)
      result.copied += nested.copied
      result.skippedLarge += nested.skippedLarge
      result.skippedDirs += nested.skippedDirs
      result.errors.push(...nested.errors)
      continue
    }

    try {
      if (options?.maxSize != null) {
        const stat = fs.statSync(srcPath)
        if (stat.size > options.maxSize) {
          result.skippedLarge += 1
          logger.warn(`[copySyncDirectory] 跳过大文件: ${srcPath} (${stat.size} bytes)`)
          continue
        }
      }
      fs.copyFileSync(srcPath, dstPath)
      result.copied += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`${srcPath}: ${msg}`)
      logger.warn(`[copySyncDirectory] 复制失败已跳过: ${srcPath} (${msg})`)
    }
  }

  return result
}
