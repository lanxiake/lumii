/**
 * 云同步目录复制工具：导出/导入共用。
 * 跳过 .git 等重目录，支持大文件阈值，单文件失败不阻断整树复制。
 *
 * 可选 `mirror`：复制后删除目标侧、源侧已不存在的条目，用于传播删除。
 * 仅 export 方向（本地 → sync）应开启；import 方向必须用默认值，
 * 否则会用远端快照删空本地 —— 两侧状态无法区分「删除」与「新增」。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../logger'

const logger = createLogger('cloud-sync/copy')

/**
 * outputs 单文件同步上限的**兜底值**（配置缺 `smallFileThresholdBytes` 时使用）。
 *
 * 分级传输（T4.4）后真正的阈值由 `CloudSyncConfig.smallFileThresholdBytes` 驱动：
 * 阶段一只传 ≤ 阈值 的文件，更大者由 `sync-large-queue` 分批传 ——
 * 超限不再是"跳过即丢弃"（旧语义），而是"交给阶段二"。
 */
export const SYNC_OUTPUTS_MAX_BYTES = 5 * 1024 * 1024

/** 镜像删除单次上限：待删条目超过此数则整批放弃 */
export const SYNC_MIRROR_MAX_DELETES = 200

/** 镜像删除比例上限：待删占目标条目数比例超过此值则整批放弃 */
export const SYNC_MIRROR_MAX_DELETE_RATIO = 0.5

/**
 * mtime 比对容差（毫秒）。
 *
 * **不能要求严格相等**：源文件的 mtime 是文件系统原生精度（NTFS 100ns，`mtimeMs`
 * 带亚毫秒小数），而 `utimesSync` 回写后读回会被舍入到整数 ms —— 实测差 0.218ms。
 * 严格比较会让「刚复制完的文件」下一轮又被判为未同步，阶段二队列因此陷入死循环
 * （2026-09-17 实测：108 批全在传同一个 32.5MB 文件，本地 tip 始终追不上远端）。
 *
 * 2ms 足以覆盖这种舍入（也覆盖 FAT 的秒级精度差异），又远小于任何人手改文件的间隔
 * —— 不会漏检真实变更。
 */
export const SYNC_MTIME_TOLERANCE_MS = 2

/** 待删条目少于此数时不套用比例阈值：小目录删一半是正常操作，不是事故 */
export const SYNC_MIRROR_RATIO_MIN_COUNT = 10

/**
 * 待删集合的指纹：排序后取 sha256 前 16 位。
 *
 * 用于把「用户确认」绑定到**具体这一批**待删项 —— 集合一变指纹就变，确认自动失效。
 * 这是 2026-09-16 远端清空事故的修复核心：原来的布尔确认在两次自动同步之间
 * 就自行放行了，等于没有确认。
 */
export function computeStaleFingerprint(stalePaths: readonly string[]): string {
  const sorted = [...stalePaths].sort()
  return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16)
}

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
   * 已确认放行的待删集合指纹（来自显式用户确认）。
   *
   * **只有**本次实际待删集合的指纹与之完全一致时才跳过安全阀 —— 用指纹而非布尔，
   * 是因为"用户确认的是这一批"。自动触发的同步永远拿不到匹配指纹，因此不会再自行放行。
   */
  confirmedFingerprint?: string
  /**
   * 增量短路：源与目标的 size + mtime 都相同则跳过复制（默认关闭）。
   *
   * 开启后每次复制会用 utimesSync 把源文件的 mtime 写到目标上 —— 否则目标 mtime
   * 恒为复制时刻，比对永不相等，短路形同虚设。
   *
   * 仅应在 **export 方向**开启：import 方向是「远端覆盖本地」，宁可多复制一次，
   * 也不要冒漏更新的风险。
   */
  skipUnchanged?: boolean
  /**
   * 路径级排除（相对 src 目录、`/` 分隔）：返回 true 则跳过该文件。
   *
   * **跳过的名字仍留在 srcNames 里** —— 目标侧同名旧版本不会被镜像删除误删
   * （与"跳过大文件"同一语义：跳过 ≠ 删除）。
   */
  shouldSkipFile?: (relPath: string) => boolean
  /** 强制包含（相对 src 目录）：命中者无视 maxSize 上限 */
  shouldForceInclude?: (relPath: string) => boolean
}

export interface CopySyncDirectoryResult {
  copied: number
  skippedLarge: number
  skippedDirs: number
  errors: string[]
  /**
   * 因超 maxSize 被跳过的文件**绝对路径**。
   *
   * 上层据此从 git stage 的「删除判定」中排除它们：分级传输下阶段一导出跳过的大文件
   * 不在工作区却存在于 HEAD，不排除的话每跑一次阶段一就把阶段二提交的大文件删一次。
   */
  skippedLargePaths: string[]
  /** 增量短路跳过的文件数（size + mtime 均未变） */
  skippedUnchanged: number
  /** 被同步范围规则排除的文件数 */
  skippedExcluded: number
  /** 镜像模式下实际删除的条目数 */
  deleted: number
  /** 镜像删除因超阈值被整批放弃（源目录可能异常，删除未传播） */
  deleteAborted: boolean
  /** 被挡下时：待删集合指纹。用户确认时需原样回传该值 */
  abortedFingerprint?: string
  /** 被挡下时：待删条目数（供 UI 展示） */
  abortedCount?: number
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
    skippedLargePaths: [],
    skippedUnchanged: 0,
    skippedExcluded: 0,
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
      const srcStat = fs.statSync(srcPath)
      const rel = path.relative(src, srcPath).split(path.sep).join('/')

      // 同步范围排除：名字已留在 srcNames → 不触发镜像删除
      if (options?.shouldSkipFile?.(rel)) {
        result.skippedExcluded += 1
        continue
      }

      if (
        options?.maxSize != null &&
        srcStat.size > options.maxSize &&
        !options.shouldForceInclude?.(rel)
      ) {
        result.skippedLarge += 1
        result.skippedLargePaths.push(srcPath)
        // ⚠️ 这里**刻意不逐条打日志**（2026-09-20 改）。原因见
        // docs/fix/2026-09-20-主进程冻结调查与修复.md 第六节：
        // 这条路一天能产生数万条 WARN（09-19 实测 71893 条），而 Windows 上 Node 对
        // **管道** stdout 是**同步写** —— 日志量撑爆管道缓冲（约 64KB）且读端跟不上时，
        // 同步写会阻塞主线程，**冻结时长完全由读端决定**（实测到 8 秒、54 秒、606 秒）。
        // 数量与路径都已记入 result，调用方 sync-exporter 会打一条带示例的汇总。
        // 名字留在 srcNames 里：目标侧同名旧版本不删，避免「跳过」被误当成「删除」
        continue
      }

      // 增量短路：size + mtime 双条件都相同才认为内容一致。
      // 单看 size 会漏掉等长改写；单看 mtime 会被精度差异干扰 —— 两条都要满足。
      if (options?.skipUnchanged && isSameStat(dstPath, srcStat)) {
        result.skippedUnchanged += 1
        continue
      }

      fs.copyFileSync(srcPath, dstPath)
      // 关键：把源 mtime 回写到目标。copyFileSync 不保留 mtime，目标恒为复制时刻，
      // 不回写的话下一轮比对永不相等，短路永远不生效 —— 整个优化就等于没写。
      if (options?.skipUnchanged) {
        try {
          fs.utimesSync(dstPath, srcStat.atime, srcStat.mtime)
        } catch (err) {
          // 回写失败只影响下次能否短路，不影响正确性
          logger.warn(
            `[copySyncDirectory] 保留 mtime 失败（下次将重新复制）: ${dstPath} (${err instanceof Error ? err.message : String(err)})`,
          )
        }
      }
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

  const fingerprint = computeStaleFingerprint(stale)

  // 显式确认放行：指纹必须与本次实际待删集合完全一致
  if (options.confirmedFingerprint && options.confirmedFingerprint === fingerprint) {
    logger.warn(
      `[copySyncDirectory] 用户已显式确认，执行批量删除 ${stale.length} 项（fingerprint=${fingerprint}）`,
    )
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
    result.abortedFingerprint = fingerprint
    result.abortedCount = stale.length
    logger.warn(
      `[copySyncDirectory] 镜像删除已被安全阀挡下：待删 ${stale.length} 项 / 目标 ${ctx.scanned} 项` +
        `（上限 ${maxDeletes} 项或 ${SYNC_MIRROR_MAX_DELETE_RATIO * 100}%）。` +
        `源目录可能异常。删除必须由用户在设置页显式确认后才会执行（fingerprint=${fingerprint}）。` +
        `样例: ${stale.slice(0, 3).join(', ')}`,
    )
    return
  }

  for (const target of stale) {
    if (removeEntry(target, result)) result.deleted += 1
  }
  logger.info(`[copySyncDirectory] 镜像删除 ${result.deleted} 项`)
}

/**
 * 目标文件与源的 size + mtime 是否一致（可跳过复制）。
 *
 * mtime 用**容差**比较而非严格相等 —— 原因见 `SYNC_MTIME_TOLERANCE_MS` 的注释
 * （utimesSync 的舍入会让严格比较永远失败）。
 * 目标不存在或读取失败一律返回 false（必须复制）。
 */
function isSameStat(dstPath: string, srcStat: fs.Stats): boolean {
  try {
    const dstStat = fs.statSync(dstPath)
    return (
      dstStat.size === srcStat.size &&
      Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) <= SYNC_MTIME_TOLERANCE_MS
    )
  } catch {
    return false
  }
}

/** 删除条目（文件或目录），失败记入 errors 并返回 false */function removeEntry(target: string, result: CopySyncDirectoryResult): boolean {
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
