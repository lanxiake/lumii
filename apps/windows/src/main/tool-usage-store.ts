/**
 * 工具调用次数统计（技能 / MCP / 系统工具）
 *
 * 存 SQLite `tool_usage_stats` 表（schema V13 新增），全量小对象（工具数量级几百），
 * 内存累加 + 延迟落盘：不像 usage-store 那样一次调用一行，
 * 这里只关心「累计次数 + 最后使用时间」，UPSERT 覆盖写最省事。
 *
 * 为兼容历史版本，启动时如检测到旧 `~/.lumii/usage/tool-usage.json`，
 * 做一次性数据迁移（JSON → SQLite），完成后 JSON 重命名为 `.bak`。
 * 当 SQLite 适配器未注入（测试/降级路径）时，退化为纯内存 Map，
 * 保证统计失败绝不影响对话流程。
 *
 * 用途：让用户看到哪些工具高频、哪些从未用过，据此手动关掉长期不用的，省上下文。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from './client-data-root'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'

/** 单个工具的累计用量 */
export interface ToolUsageStat {
  /** 累计调用次数（含失败） */
  count: number
  /** 其中失败次数 */
  errorCount: number
  /** 最后一次调用时刻（epoch ms） */
  lastUsedAt: number
}

/** 工具名 → 用量 */
export type ToolUsageMap = Record<string, ToolUsageStat>

const SAVE_DEBOUNCE_MS = 2000

let cache: ToolUsageMap | null = null
let saveTimer: NodeJS.Timeout | null = null
let dirty = false
let dbAdapter: DatabaseAdapter | null = null
let migrationDone = false

function storePath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'usage', 'tool-usage.json')
}

function isStat(value: unknown): value is ToolUsageStat {
  return typeof (value as ToolUsageStat)?.count === 'number'
}

/** 读取旧 JSON（仅迁移用）；失败返回空 map */
async function readLegacyJson(): Promise<ToolUsageMap> {
  try {
    const raw = await fs.readFile(storePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const valid: ToolUsageMap = {}
    for (const [name, stat] of Object.entries(parsed)) {
      if (isStat(stat)) {
        valid[name] = {
          count: stat.count,
          errorCount: typeof stat.errorCount === 'number' ? stat.errorCount : 0,
          lastUsedAt: typeof stat.lastUsedAt === 'number' ? stat.lastUsedAt : 0,
        }
      }
    }
    return valid
  } catch {
    return {}
  }
}

/** 从 SQLite 载入内存；没注入 db 时返回 {} */
function loadFromDb(): ToolUsageMap {
  if (!dbAdapter) return {}
  try {
    const rows = dbAdapter
      .prepare<{ tool_name: string; count: unknown; error_count: unknown; last_used_at: unknown }>(
        'SELECT tool_name, count, error_count, last_used_at FROM tool_usage_stats',
      )
      .all()
    const result: ToolUsageMap = {}
    for (const row of rows) {
      const count = typeof row.count === 'number' ? row.count : Number(row.count)
      const errorCount = typeof row.error_count === 'number' ? row.error_count : Number(row.error_count)
      const lastUsedAt =
        row.last_used_at == null
          ? 0
          : typeof row.last_used_at === 'number'
            ? row.last_used_at
            : Number(row.last_used_at)
      if (!Number.isFinite(count)) continue
      result[row.tool_name] = {
        count,
        errorCount: Number.isFinite(errorCount) ? errorCount : 0,
        lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : 0,
      }
    }
    return result
  } catch (err) {
    console.error('[ToolUsageStore] 从 SQLite 载入失败（退回空 map）:', err)
    return {}
  }
}

/**
 * 旧 JSON → SQLite 一次性迁移。
 * - 以 JSON 为"真"（升级前的运行时最新值一定在 JSON）
 * - SQLite 中已有条目时：count/errorCount 取 max(last_used_at 新的那个的 count, json的count)；简单起见 JSON 有值就覆盖 SQLite
 * - 成功后把 tool-usage.json → tool-usage.json.bak
 */
async function tryMigrateLegacyJsonIfNeeded(): Promise<void> {
  if (migrationDone) return
  migrationDone = true
  if (!dbAdapter) return
  const legacyPath = storePath()
  try {
    await fs.access(legacyPath)
  } catch {
    // 没有旧文件，标记完成即可
    return
  }
  const legacy = await readLegacyJson()
  const entries = Object.entries(legacy)
  if (entries.length === 0) {
    // 空文件或全无效，直接归档
    try {
      await fs.rename(legacyPath, `${legacyPath}.bak`)
    } catch {
      /* ignore */
    }
    return
  }
  try {
    dbAdapter.exec('BEGIN IMMEDIATE')
    const stmt = dbAdapter.prepare(
      `INSERT INTO tool_usage_stats (tool_name, count, error_count, last_used_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tool_name) DO UPDATE SET
         count = excluded.count,
         error_count = excluded.error_count,
         last_used_at = excluded.last_used_at`,
    )
    for (const [toolName, s] of entries) {
      stmt.run(toolName, s.count, s.errorCount, s.lastUsedAt || null)
    }
    dbAdapter.exec('COMMIT')
    console.info(`[ToolUsageStore] 已从 JSON 迁移 ${entries.length} 条工具统计到 SQLite`)
    try {
      await fs.rename(legacyPath, `${legacyPath}.bak`)
    } catch {
      /* 归档失败不影响迁移结果 */
    }
    // 合并进内存 cache（JSON 覆盖已载入的 DB 值）
    if (cache) {
      for (const [toolName, s] of entries) {
        cache[toolName] = s
      }
    }
  } catch (err) {
    try {
      dbAdapter.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    console.error('[ToolUsageStore] 迁移 JSON → SQLite 失败（已忽略，继续运行）:', err)
  }
}

/** 读盘（仅首次）；文件缺失或损坏都退回空统计，绝不让统计影响对话 */
async function ensureLoaded(): Promise<ToolUsageMap> {
  if (cache) return cache
  cache = loadFromDb()
  // 先尝试异步迁移，不阻塞首次读（迁移完成后已写入 cache 中合并条目，下次读取会反映）
  void tryMigrateLegacyJsonIfNeeded()
  return cache
}

/** 把内存 Map 全部 UPSERT 进 SQLite */
function flushToDb(): void {
  if (!dbAdapter || !cache) return
  const entries = Object.entries(cache)
  if (entries.length === 0) return
  try {
    dbAdapter.exec('BEGIN IMMEDIATE')
    const stmt = dbAdapter.prepare(
      `INSERT INTO tool_usage_stats (tool_name, count, error_count, last_used_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tool_name) DO UPDATE SET
         count = excluded.count,
         error_count = excluded.error_count,
         last_used_at = excluded.last_used_at`,
    )
    for (const [toolName, s] of entries) {
      stmt.run(
        toolName,
        s.count,
        s.errorCount,
        s.lastUsedAt > 0 ? s.lastUsedAt : null,
      )
    }
    dbAdapter.exec('COMMIT')
  } catch (err) {
    try {
      dbAdapter.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    console.error('[ToolUsageStore] 写入 SQLite 失败（已忽略）:', err)
  }
}

/** 仅在未注入 db 时退化为 JSON 写盘（测试场景等），避免永久内存态丢数据 */
async function flushToLegacyJsonFallback(): Promise<void> {
  if (dbAdapter || !cache) return
  try {
    const file = storePath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(cache), 'utf-8')
  } catch (err) {
    console.error('[ToolUsageStore] 写入降级 JSON 失败（已忽略）:', err)
  }
}

async function flushNow(): Promise<void> {
  if (!dirty || !cache) return
  dirty = false
  if (dbAdapter) {
    flushToDb()
  } else {
    await flushToLegacyJsonFallback()
  }
}

function scheduleSave(): void {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushNow()
  }, SAVE_DEBOUNCE_MS)
  // 定时器不应阻止进程退出
  saveTimer.unref?.()
}

/**
 * 可选调用：启动时注入 SQLite 适配器（调用者应在 bridge.localDb 就绪后调用）。
 * 未注入时退化为内存态（加 JSON fallback 写入），不影响现有流程。
 */
export function initToolUsageStore(db: DatabaseAdapter | null | undefined): void {
  if (!db) return
  dbAdapter = db
  // 已从旧 JSON（ensureLoaded 初次读的）加载进 cache 的场景：这里不显式重载，
  // 下一次 flushNow() 会把内存态写回 DB；而 DB 已有的数据需要重新载入：
  if (cache) {
    // 合并 DB + 现有 cache（cache 为准，因缓存里可能是启动瞬间新产生的调用）
    const fromDb = loadFromDb()
    for (const [k, v] of Object.entries(fromDb)) {
      if (!cache[k]) cache[k] = v
    }
  }
  // 迁移尝试（即便 cache 还没初始化也没关系，tryMigrateLegacyJsonIfNeeded 里会先读旧 JSON）
  void tryMigrateLegacyJsonIfNeeded()
}

/**
 * 记录一次工具调用。内存累加，延迟合并落盘。
 *
 * 统计失败绝不能影响对话，因此不抛异常。
 */
export async function recordToolUsage(toolName: string, isError = false): Promise<void> {
  if (!toolName) return
  const map = await ensureLoaded()
  const prev = map[toolName] ?? { count: 0, errorCount: 0, lastUsedAt: 0 }
  map[toolName] = {
    count: prev.count + 1,
    errorCount: prev.errorCount + (isError ? 1 : 0),
    lastUsedAt: Date.now(),
  }
  scheduleSave()
}

/** 读取全部工具用量（从未调用过的工具不在其中，由调用方按 0 处理） */
export async function getToolUsage(): Promise<ToolUsageMap> {
  return { ...(await ensureLoaded()) }
}

/** 退出前强制落盘，避免丢掉 debounce 窗口内的计数 */
export async function flushToolUsage(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  await flushNow()
}

/** 仅测试用：重置模块内存态 */
export function __resetToolUsageCacheForTest(): void {
  cache = null
  dirty = false
  dbAdapter = null
  migrationDone = false
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}
