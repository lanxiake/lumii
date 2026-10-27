/**
 * 自动清理编排：TTL → 配额 → 回收站到期。
 *
 * 所有删除都走 `workspace-cleanup` 的安全闸（只动过程文件、先回收站、引用跳过）；
 * 这里只负责「什么时候跑、跑几轮、阈值多少」。
 *
 * 默认策略（D7）：中间 7 天 / 临时 24 小时；工作区超过 10GB 时按最老优先清到 80%；
 * 回收站批次 7 天后真删。关闭开关 = 完全不跑（连扫描都不做）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { purgeTrash, runCleanup, scanWorkspace } from './workspace-cleanup'
import { pruneEditStore, pruneWorkspaceScratch } from './artifact-edit'
import { recoverDedupeTemps } from './workspace-dedupe'
import { pruneTurnVersions } from './turn-version-store'
import { getLocalDateString } from './local-time'

export interface StorageCleanupPrefs {
  enabled: boolean
  intermediateDays: number
  ephemeralHours: number
  quotaGb: number
  targetPercent: number
  trashDays: number
}

export const DEFAULT_STORAGE_CLEANUP_PREFS: StorageCleanupPrefs = {
  enabled: true,
  intermediateDays: 7,
  ephemeralHours: 24,
  quotaGb: 10,
  targetPercent: 80,
  trashDays: 7,
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 脏配置回默认；`enabled` 缺失按开启（默认即用，关掉是显式动作） */
export function normalizeStorageCleanupPrefs(raw: unknown): StorageCleanupPrefs {
  if (!raw || typeof raw !== 'object') return DEFAULT_STORAGE_CLEANUP_PREFS
  const value = raw as Record<string, unknown>
  const targetPercent = positive(value.targetPercent, DEFAULT_STORAGE_CLEANUP_PREFS.targetPercent)
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_STORAGE_CLEANUP_PREFS.enabled,
    intermediateDays: positive(value.intermediateDays, DEFAULT_STORAGE_CLEANUP_PREFS.intermediateDays),
    ephemeralHours: positive(value.ephemeralHours, DEFAULT_STORAGE_CLEANUP_PREFS.ephemeralHours),
    quotaGb: positive(value.quotaGb, DEFAULT_STORAGE_CLEANUP_PREFS.quotaGb),
    targetPercent: Math.min(95, Math.max(50, targetPercent)),
    trashDays: positive(value.trashDays, DEFAULT_STORAGE_CLEANUP_PREFS.trashDays),
  }
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export interface ScheduledCleanupResult {
  ran: boolean
  /** 没跑的原因（disabled / not-idle / busy） */
  reason?: string
  ttlRemoved: number
  ttlBytes: number
  quotaRemoved: number
  quotaBytes: number
  trashRemoved: number
  /** 已应用编辑里被清理掉内容副本的数量（meta 保留） */
  editsPruned: number
  errors: string[]
}

/**
 * 跑一轮自动清理。
 * `idleSeconds` 由调用方给（主进程 powerMonitor）；不足 5 分钟直接跳过——
 * 用户正在干活时不抢 IO。
 */
export async function runScheduledCleanup(opts: {
  dir: string
  prefs: StorageCleanupPrefs
  idleSeconds: number
  logDir?: string
  budgetBytesForTest?: number
}): Promise<ScheduledCleanupResult> {
  const result: ScheduledCleanupResult = {
    ran: false,
    ttlRemoved: 0,
    ttlBytes: 0,
    quotaRemoved: 0,
    quotaBytes: 0,
    trashRemoved: 0,
    editsPruned: 0,
    errors: [],
  }
  if (!opts.prefs.enabled) return { ...result, reason: 'disabled' }
  if (opts.idleSeconds < 300) return { ...result, reason: 'not-idle' }

  result.ran = true
  // 0) 去重崩溃残留：把 `.lumii/tmp/dedupe/` 里的临时副本放回原位
  try {
    await recoverDedupeTemps({ dir: opts.dir })
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
  }
  const base = { dir: opts.dir, dryRun: false, trigger: 'ttl' as const, ...(opts.logDir ? { logDir: opts.logDir } : {}) }

  // 1) TTL：中间产物与临时文件阈值不同，分两轮
  try {
    const intermediate = await runCleanup({
      ...base,
      target: 'intermediate',
      olderThanMs: opts.prefs.intermediateDays * DAY_MS,
    })
    result.ttlRemoved += intermediate.removed
    result.ttlBytes += intermediate.bytes
    if (!intermediate.ok && intermediate.error) result.errors.push(intermediate.error)
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
  }
  try {
    const ephemeral = await runCleanup({
      ...base,
      target: 'ephemeral',
      olderThanMs: opts.prefs.ephemeralHours * HOUR_MS,
    })
    result.ttlRemoved += ephemeral.removed
    result.ttlBytes += ephemeral.bytes
    if (!ephemeral.ok && ephemeral.error) result.errors.push(ephemeral.error)
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
  }

  // 2) 配额：只统计可清理的两类，超阈值就清到目标比例
  try {
    // 大工作区（本机 1.4 万个文件）用默认 1.5s 会被截断 → 配额永不触发；给足 8s
    const scan = await scanWorkspace({ dir: opts.dir, budgetMs: 8000 })
    const usage = scan.classes.intermediate.bytes + scan.classes.ephemeral.bytes
    const quota = opts.prefs.quotaGb * 1024 * 1024 * 1024
    if (usage > quota) {
      const target = (quota * opts.prefs.targetPercent) / 100
      const budget = opts.budgetBytesForTest ?? Math.max(0, usage - target)
      if (budget > 0) {
        const trimmed = await runCleanup({
          ...base,
          target: 'both',
          trigger: 'quota',
          budgetBytes: budget,
        })
        result.quotaRemoved += trimmed.removed
        result.quotaBytes += trimmed.bytes
        if (!trimmed.ok && trimmed.error) result.errors.push(trimmed.error)
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
  }

  // 3) 回收站到期：批次整体删除
  try {
    const purged = await purgeTrash({ dir: opts.dir, olderThanMs: opts.prefs.trashDays * DAY_MS })
    result.trashRemoved = purged.removed
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
  }

  // 4) 编辑候选 / 导出临时文件：未应用 24h、已应用内容 30 天或 1GB 上限
  try {
    const pruned = await pruneEditStore({ workspaceDir: opts.dir })
    result.editsPruned = pruned.prunedContents
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
  }
  try {
    await pruneWorkspaceScratch({ workspaceDir: opts.dir })
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
  }
  try {
    await pruneTurnVersions({ workspaceDir: opts.dir })
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
  }

  return result
}

/** 今天是否已经跑过（读审计文件；启动补跑用） */
export async function hasRunCleanupToday(logDir: string, now: Date = new Date()): Promise<boolean> {
  const file = path.join(logDir, `cleanup-${getLocalDateString(now).replace(/-/g, '')}.jsonl`)
  try {
    const text = await fs.readFile(file, 'utf8')
    return text.trim().length > 0
  } catch {
    return false
  }
}
