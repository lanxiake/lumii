/**
 * 云同步目录复制工具：导出/导入共用。
 * 跳过 .git 等重目录，支持大文件阈值，单文件失败不阻断整树复制。
 *
 * 可选 `mirror`：复制后删除目标侧、源侧已不存在的条目，用于传播删除。
 * 仅 export 方向（本地 → sync）应开启；import 方向必须用默认值，
 * 否则会用远端快照删空本地 —— 两侧状态无法区分「删除」与「新增」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../logger'

const logger = createLogger('cloud-sync/copy')

/** outputs 同步单文件上限：超过则跳过（避免仓库膨胀与推送超时） */
export const SYNC_OUTPUTS_MAX_BYTES = 5 * 1024 * 1024

/** 镜像删除单次上限：待删条目超过此数则整批放弃 */
export const SYNC_MIRROR_MAX_DELETES = 200

/** 镜像删除比例上限：待删占目标条目数比例超过此值则整批放弃 */
export const SYNC_MIRROR_MAX_DELETE_RATIO = 0.5

/** 待删条目少于此数时不套用比例阈值：小目录删一半是正常操作，不是事故 */
export const SYNC_MIRROR_RATIO_MIN_COUNT = 10

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
  /**
   * true：复制后删除目标侧、源侧已不存在的条目（真镜像）。
   * 默认 false，保持「只增不减」。
   */
  mirror?: boolean
  /** 覆盖 SYNC_MIRROR_MAX_DELETES */
  maxDeletes?: number
  /**
   * true：跳过全部安全阀，直接执行镜像删除。
   * 用于「用户已二次确认」的批量删除 —— 见 CloudSyncManager 的二次确认逻辑。
   */
  forceDeletes?: boolean
}

export interface CopySyncDirectoryResult {
  copied: number
  skippedLarge: number
  skippedDirs: number
  errors: string[]
  /** 镜像模式下实际删除的条目数 */
  deleted: number
  /** 镜像删除因超阈值被整批放弃（源目录可能异常，删除未传播） */
  deleteAborted: boolean
}

/** 递归过程的可变上下文：整棵树收集完待删项后再统一判定阈值 */
interface CopyContext {
  options?: CopySyncDirectoryOptions
  result: CopySyncDirectoryResult
  /** 目标侧有、源侧没有的绝对路径（尚待阈值判定） */
  stale: string[]
  /** 目标侧遍历到的条目总数（比例阈值分母） */
  scanned: number
}

/**
 * 判断目录项是否应跳过递归复制。
 */
export function shouldSkipSyncCopyDir(entryName: string): boolean {
  return SYNC_SKIP_DIR_NAMES.has(entryName)
}

/**
 * 递归复制目录；跳过 SYNC_SKIP_DIR_NAMES，按需跳过大文件，单文件 EPERM 等记入 errors 后继续。
 *
 * mirror 模式下的安全阀（任一触发即整批放弃删除，只记 warning，不中断同步）：
 *  - 源目录不存在 / 任一层源目录读不出 → 该层不参与删除
 *  - 待删条目超 maxDeletes，或占比超 SYNC_MIRROR_MAX_DELETE_RATIO（且数量够多）
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
    deleted: 0,
    deleteAborted: false,
  }

  // 源不存在：镜像模式也绝不删除 —— 此刻的「源为空」不是删除信号，是快照不可信
  if (!fs.existsSync(src)) return result

  const ctx: CopyContext = { options, result, stale: [], scanned: 0 }
  copyLevel(src, dst, ctx)
  applyMirrorDeletes(ctx)

  return result
}

/**
 * 复制一层：先逐项复制，再比对目标侧多出的条目记入 ctx.stale。
 * 源目录读不出时直接返回 —— 该子树既不复制也不删。
 */
function copyLevel(src: string, dst: string, ctx: CopyContext): void {
  const { options, result } = ctx

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(src, { withFileTypes: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`${src}: ${msg}`)
    logger.warn(`[copySyncDirectory] 无法读取目录: ${src} (${msg})`)
    return
  }

  if (!fs.existsSync(dst)) {
    fs.mkdirSync(dst, { recursive: true })
  }

  // 目标侧只读一次：既做镜像比对，又计入比例阈值分母
  let dstNames: Set<string> | null = null
  try {
    const dstEntries = fs.readdirSync(dst, { withFileTypes: true })
    dstNames = new Set(dstEntries.map((e) => e.name))
    ctx.scanned += dstEntries.length
  } catch {
    // 目标侧读不出（首次复制目录刚建、或权限异常）→ 本层不做镜像比对
    dstNames = null
  }

  const srcNames = new Set<string>()

  for (const entry of entries) {
    srcNames.add(entry.name)
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)

    if (entry.isDirectory()) {
      if (shouldSkipSyncCopyDir(entry.name)) {
        result.skippedDirs += 1
        logger.info(`[copySyncDirectory] 跳过目录: ${srcPath}`)
        // 清掉目标侧历史残留（例如上次误拷入的嵌套 .git），避免 sync 仓膨胀/推送超时
        removeEntry(dstPath, result)
        continue
      }
      copyLevel(srcPath, dstPath, ctx)
      continue
    }

    try {
      if (options?.maxSize != null) {
        const stat = fs.statSync(srcPath)
        if (stat.size > options.maxSize) {
          result.skippedLarge += 1
          logger.warn(`[copySyncDirectory] 跳过大文件: ${srcPath} (${stat.size} bytes)`)
          // 名字留在 srcNames 里：目标侧同名旧版本不删，避免「跳过」被误当成「删除」
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

  if (options?.mirror && dstNames) {
    for (const name of dstNames) {
      if (!srcNames.has(name)) ctx.stale.push(path.join(dst, name))
    }
  }
}

/** 整棵树收集完后统一判定阈值并执行删除 */
function applyMirrorDeletes(ctx: CopyContext): void {
  const { options, result, stale } = ctx
  if (!options?.mirror || stale.length === 0) return

  if (options.forceDeletes) {
    logger.warn(`[copySyncDirectory] 跳过安全阀，直接删除 ${stale.length} 项（用户已确认）`)
    for (const target of stale) {
      if (removeEntry(target, result)) result.deleted += 1
    }
    return
  }

  const maxDeletes = options.maxDeletes ?? SYNC_MIRROR_MAX_DELETES
  const ratio = stale.length / Math.max(1, ctx.scanned)
  const ratioExceeded =
    stale.length >= SYNC_MIRROR_RATIO_MIN_COUNT && ratio > SYNC_MIRROR_MAX_DELETE_RATIO

  if (stale.length > maxDeletes || ratioExceeded) {
    result.deleteAborted = true
    logger.warn(
      `[copySyncDirectory] 镜像删除已挡下一次：待删 ${stale.length} 项 / 目标 ${ctx.scanned} 项` +
        `（上限 ${maxDeletes} 项或 ${SYNC_MIRROR_MAX_DELETE_RATIO * 100}%）。` +
        `源目录可能异常，本次删除未传播；再次同步即视为用户确认并执行。` +
        `样例: ${stale.slice(0, 3).join(', ')}`,
    )
    return
  }

  for (const target of stale) {
    if (removeEntry(target, result)) result.deleted += 1
  }
  logger.info(`[copySyncDirectory] 镜像删除 ${result.deleted} 项`)
}

/** 删除条目（文件或目录），失败记入 errors 并返回 false */
function removeEntry(target: string, result: CopySyncDirectoryResult): boolean {
  if (!fs.existsSync(target)) return false
  try {
    fs.rmSync(target, { recursive: true, force: true })
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`${target}: 清理失败 ${msg}`)
    logger.warn(`[copySyncDirectory] 清理失败: ${target} (${msg})`)
    return false
  }
}
