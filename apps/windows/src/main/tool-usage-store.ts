/**
 * 工具调用次数统计（技能 / MCP / 系统工具）
 *
 * 存 `~/.lumii/usage/tool-usage.json`，全量小对象（工具数量级几百），
 * 内存累加 + 延迟落盘：不像 usage-store 那样一次调用一行，
 * 这里只关心「累计次数 + 最后使用时间」，覆盖写整个对象最省事。
 *
 * 用途：让用户看到哪些工具高频、哪些从未用过，据此手动关掉长期不用的，省上下文。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from './client-data-root'

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

function storePath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'usage', 'tool-usage.json')
}

function isStat(value: unknown): value is ToolUsageStat {
  return typeof (value as ToolUsageStat)?.count === 'number'
}

/** 读盘（仅首次）；文件缺失或损坏都退回空统计，绝不让统计影响对话 */
async function ensureLoaded(): Promise<ToolUsageMap> {
  if (cache) return cache
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
    cache = valid
  } catch {
    cache = {}
  }
  return cache
}

async function flushNow(): Promise<void> {
  if (!dirty || !cache) return
  dirty = false
  try {
    const file = storePath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(cache), 'utf-8')
  } catch (err) {
    console.error('[ToolUsageStore] 写入工具用量失败（已忽略）:', err)
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
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}
