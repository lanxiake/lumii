/**
 * 工具调用次数统计（技能 / MCP / 系统工具）
 *
 * 两张表、两种问题：
 * - `tool_usage_stats`（V13 新增，V44 加 agent 维度）：**累计**——「这个工具一共被用过几次」
 * - `tool_usage_daily`（V46）：**按日**——「最近还在用吗」。B1 的靶子搞错正是因为
 *   拿累计数字当当前状态看（那 181 次失败全是历史存量），逐 Agent 的取舍决策不能重蹈。
 *
 * 内存累加 + 延迟落盘：不像 usage-store 那样一次调用一行，这里只关心「累计次数 +
 * 最后使用时间」，UPSERT 覆盖写最省事。落盘走**脏键集合**——只写这一轮变过的键，
 * 而不是每次把整张内存表重写一遍（加了按日维度之后，后者会直接从"浪费"变成"卡"）。
 *
 * **为什么有 agent 维度**：原表只有 tool_name 一个主键，「维护到底用没用过 wiki_read」
 * 这类逐 Agent 的取舍问题答不了。归因用的是**定义 id**（`chronicler`），不是实例 id
 * （`agent-1789…`）——实例不落库，存下来等于埋一个解不开的外键。
 *
 * 为兼容历史版本，启动时如检测到旧 `~/.lumii/usage/tool-usage.json`，
 * 做一次性数据迁移（JSON → SQLite），完成后 JSON 重命名为 `.bak`。
 * 当 SQLite 适配器未注入（测试/降级路径）时，退化为纯内存 Map，
 * 保证统计失败绝不影响对话流程。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from './client-data-root'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'

/** 单个工具的累计用量 */
interface ToolUsageStat {
  /** 累计调用次数（含失败） */
  count: number
  /** 其中失败次数 */
  errorCount: number
  /** 最后一次调用时刻（epoch ms） */
  lastUsedAt: number
}

/** 工具名 → 用量 */
export type ToolUsageMap = Record<string, ToolUsageStat>

/** Agent 定义 id → 该 Agent 的工具用量 */
export type ToolUsageByAgent = Record<string, ToolUsageMap>

/**
 * V44 之前的历史计数无法归因（全局计数没记下是哪次调用贡献的），统一落在这个 id 下。
 * 不写 instanceId——那等于又埋一个解不开的外键。
 */
export const UNKNOWN_AGENT_ID = 'unknown'

/**
 * 取不到渠道时的落点。**刻意不猜 `'ipc'`**（V56 迁移注释）：
 * 猜错的代价是让「unknown 占比 < 1%」这条验收标准失去意义——它会把真实的归因失败
 * 藏在默认值里。与 V44 的 `UNKNOWN_AGENT_ID` 同一原则。
 */
export const UNKNOWN_CHANNEL = 'unknown'

/**
 * 按日数据保留天数。真实增长量级是「实际用到的组合」，不是三者相乘的理论上限
 *
 * @lintignore tool-usage-store.test.ts 用 `{ ...mod }` 展开模块对象后取它，静态追不到（计划文档 §4.9）
 */
export const DAILY_RETENTION_DAYS = 90

const SAVE_DEBOUNCE_MS = 2000

/**
 * 复合脏键 / 缓存键的分隔符。
 *
 * 不能用空格：加了 channel 之后键变成三段，原先那套「切第一个空格」的写法
 * 在三段上会把 channel 一起吞进 agentId——静默把 A 的数据算到 B 头上。
 * 用 NUL（源码里写成转义，别写字面量——字面 NUL 会让 git 把整个文件当二进制，
 * 从此每次改动都看不出 diff，这正是这个文件此前打不开路的原因）。
 * NUL 不可能出现在 agent 定义 id（slug）、渠道名（枚举）或工具名里。
 */
const KEY_SEP = '\u0000'

/** 用量缓存的键：agent × channel（工具名是内层 map 的键） */
function scopedKey(agentId: string, channel: string): string {
  return `${agentId}${KEY_SEP}${channel}`
}

/** 拆 `agent + channel`；没有分隔符的键（老内存态）按 unknown 渠道处理 */
function parseScopedKey(key: string): { agentId: string; channel: string } {
  const sep = key.indexOf(KEY_SEP)
  if (sep < 0) return { agentId: key, channel: UNKNOWN_CHANNEL }
  return { agentId: key.slice(0, sep), channel: key.slice(sep + 1) }
}

/** 按日一行；key 与字段都留着，避免从拼接串反解 */
interface DailyRow {
  day: string
  agentId: string
  channel: string
  toolName: string
  stat: ToolUsageStat
}

let cache: Map<string, ToolUsageMap> | null = null
/** key = `${day}${agentId}${channel}${toolName}`（见 dailyKey） */
let dailyCache: Map<string, DailyRow> | null = null
let dirtyStats = new Set<string>()
let dirtyDaily = new Set<string>()
let saveTimer: NodeJS.Timeout | null = null
let dirty = false
let dbAdapter: DatabaseAdapter | null = null
let migrationDone = false

function storePath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'usage', 'tool-usage.json')
}

/**
 * 本地日（YYYY-MM-DD）。
 * 刻意不用 UTC：用户问的是「今天用了什么」，UTC 日会在东八区把凌晨 8 点前算进前一天。
 */
function localDayKey(ts: number = Date.now()): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 从「今天」往回数 n 天的本地日（含今天） */
function dayKeyBefore(days: number, from: number = Date.now()): string {
  return localDayKey(from - days * 24 * 60 * 60 * 1000)
}

function dailyKey(day: string, agentId: string, channel: string, toolName: string): string {
  return `${day}${KEY_SEP}${agentId}${KEY_SEP}${channel}${KEY_SEP}${toolName}`
}

function statKey(agentId: string, channel: string, toolName: string): string {
  return `${agentId}${KEY_SEP}${channel}${KEY_SEP}${toolName}`
}

/** 拆 `agent + channel + tool`；只切两刀，工具名里万一有分隔符也不受影响 */
function parseStatKey(key: string): { agentId: string; channel: string; toolName: string } {
  const a = key.indexOf(KEY_SEP)
  const b = a < 0 ? -1 : key.indexOf(KEY_SEP, a + 1)
  if (a < 0 || b < 0) return { agentId: key, channel: UNKNOWN_CHANNEL, toolName: '' }
  return {
    agentId: key.slice(0, a),
    channel: key.slice(a + 1, b),
    toolName: key.slice(b + 1),
  }
}

function isStat(value: unknown): value is ToolUsageStat {
  return typeof (value as ToolUsageStat)?.count === 'number'
}

/** 读取旧 JSON（仅迁移用）；失败返回空 map。旧文件没有 agent 维度 */
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

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function ensureAgentBucket(map: Map<string, ToolUsageMap>, agentId: string): ToolUsageMap {
  let bucket = map.get(agentId)
  if (!bucket) {
    bucket = {}
    map.set(agentId, bucket)
  }
  return bucket
}

/** 从 SQLite 载入内存（含按日表，顺带清理过期行）；没注入 db 时返回空 */
function loadFromDb(): { stats: Map<string, ToolUsageMap>; daily: Map<string, DailyRow> } {
  const stats = new Map<string, ToolUsageMap>()
  const daily = new Map<string, DailyRow>()
  if (!dbAdapter) return { stats, daily }
  try {
    const rows = dbAdapter
      .prepare<{
        agent_id: string
        channel: string
        tool_name: string
        count: unknown
        error_count: unknown
        last_used_at: unknown
      }>('SELECT agent_id, channel, tool_name, count, error_count, last_used_at FROM tool_usage_stats')
      .all()
    for (const row of rows) {
      const count = toNumber(row.count, Number.NaN)
      if (!Number.isFinite(count)) continue
      const scope = scopedKey(row.agent_id || UNKNOWN_AGENT_ID, row.channel || UNKNOWN_CHANNEL)
      ensureAgentBucket(stats, scope)[row.tool_name] = {
        count,
        errorCount: toNumber(row.error_count),
        lastUsedAt: row.last_used_at == null ? 0 : toNumber(row.last_used_at),
      }
    }
  } catch (err) {
    console.error('[ToolUsageStore] 从 SQLite 载入累计统计失败（退回空 map）:', err)
  }

  const cutoffDay = dayKeyBefore(DAILY_RETENTION_DAYS - 1)
  try {
    const rows = dbAdapter
      .prepare<{
        day: string
        agent_id: string
        channel: string
        tool_name: string
        count: unknown
        error_count: unknown
        last_used_at: unknown
      }>('SELECT day, agent_id, channel, tool_name, count, error_count, last_used_at FROM tool_usage_daily')
      .all()
    for (const row of rows) {
      const count = toNumber(row.count, Number.NaN)
      if (!Number.isFinite(count)) continue
      const channel = row.channel || UNKNOWN_CHANNEL
      daily.set(dailyKey(row.day, row.agent_id, channel, row.tool_name), {
        day: row.day,
        agentId: row.agent_id,
        channel,
        toolName: row.tool_name,
        stat: {
          count,
          errorCount: toNumber(row.error_count),
          lastUsedAt: row.last_used_at == null ? 0 : toNumber(row.last_used_at),
        },
      })
    }
  } catch (err) {
    console.error('[ToolUsageStore] 从 SQLite 载入按日统计失败（退回空 map）:', err)
  }

  // 保留期清理：只在装载时做一次。删的是「日」这个维度的旧行，
  // 累计表动都不动——两件事分开是这两张表分家的主要理由之一。
  try {
    const res = dbAdapter
      .prepare('DELETE FROM tool_usage_daily WHERE day < ?')
      .run(cutoffDay)
    if (res.changes > 0) {
      console.info(`[ToolUsageStore] 已清理 ${res.changes} 行超过 ${DAILY_RETENTION_DAYS} 天的按日统计`)
    }
  } catch (err) {
    console.error('[ToolUsageStore] 清理过期按日统计失败（已忽略）:', err)
  }

  return { stats, daily }
}

/**
 * 旧 JSON → SQLite 一次性迁移。
 * - 以 JSON 为"真"（升级前的运行时最新值一定在 JSON）
 * - 旧文件没有 agent 维度，统一记到 `unknown`
 * - 旧文件也没有渠道维度，统一记到 `unknown`（不猜 `ipc`，见 UNKNOWN_CHANNEL）
 * - 不写按日表：旧数据没有时间信息，硬塞一个日期就是编造
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
    return
  }
  const legacy = await readLegacyJson()
  const entries = Object.entries(legacy)
  if (entries.length === 0) {
    try {
      await fs.rename(legacyPath, `${legacyPath}.bak`)
    } catch {
      /* ignore */
    }
    return
  }
  try {
    dbAdapter.exec('BEGIN IMMEDIATE')
    const stmt = statUpsertStatement()
    for (const [toolName, s] of entries) {
      stmt.run(UNKNOWN_AGENT_ID, UNKNOWN_CHANNEL, toolName, s.count, s.errorCount, s.lastUsedAt || null)
    }
    dbAdapter.exec('COMMIT')
    console.info(`[ToolUsageStore] 已从 JSON 迁移 ${entries.length} 条工具统计到 SQLite`)
    try {
      await fs.rename(legacyPath, `${legacyPath}.bak`)
    } catch {
      /* 归档失败不影响迁移结果 */
    }
    if (cache) {
      const bucket = ensureAgentBucket(cache, scopedKey(UNKNOWN_AGENT_ID, UNKNOWN_CHANNEL))
      for (const [toolName, s] of entries) bucket[toolName] = s
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

function statUpsertStatement() {
  if (!dbAdapter) throw new Error('dbAdapter not ready')
  return dbAdapter.prepare(
    `INSERT INTO tool_usage_stats (agent_id, channel, tool_name, count, error_count, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, channel, tool_name) DO UPDATE SET
       count = excluded.count,
       error_count = excluded.error_count,
       last_used_at = excluded.last_used_at`,
  )
}

function dailyUpsertStatement() {
  if (!dbAdapter) throw new Error('dbAdapter not ready')
  return dbAdapter.prepare(
    `INSERT INTO tool_usage_daily (day, agent_id, channel, tool_name, count, error_count, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, agent_id, channel, tool_name) DO UPDATE SET
       count = excluded.count,
       error_count = excluded.error_count,
       last_used_at = excluded.last_used_at`,
  )
}

async function ensureLoaded(): Promise<void> {
  if (cache && dailyCache) return
  const loaded = loadFromDb()
  cache = loaded.stats
  dailyCache = loaded.daily
  // 先尝试异步迁移，不阻塞首次读（迁移完成后已写入 cache 中合并条目，下次读取会反映）
  void tryMigrateLegacyJsonIfNeeded()
}

/** 只写这一轮变过的键——整表重写在按日维度下会从"浪费"变成"卡" */
function flushToDb(): void {
  if (!dbAdapter || !cache || !dailyCache) return
  if (dirtyStats.size === 0 && dirtyDaily.size === 0) return
  let written = 0
  try {
    dbAdapter.exec('BEGIN IMMEDIATE')
    if (dirtyStats.size > 0) {
      const stmt = statUpsertStatement()
      for (const key of dirtyStats) {
        const { agentId, channel, toolName } = parseStatKey(key)
        const s = cache.get(scopedKey(agentId, channel))?.[toolName]
        if (!s) continue
        stmt.run(agentId, channel, toolName, s.count, s.errorCount, s.lastUsedAt > 0 ? s.lastUsedAt : null)
        written++
      }
    }
    if (dirtyDaily.size > 0) {
      const stmt = dailyUpsertStatement()
      for (const key of dirtyDaily) {
        const row = dailyCache.get(key)
        if (!row) continue
        stmt.run(
          row.day,
          row.agentId,
          row.channel,
          row.toolName,
          row.stat.count,
          row.stat.errorCount,
          row.stat.lastUsedAt > 0 ? row.stat.lastUsedAt : null,
        )
        written++
      }
    }
    dbAdapter.exec('COMMIT')
    dirtyStats.clear()
    dirtyDaily.clear()
  } catch (err) {
    try {
      dbAdapter.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    // 不清脏键：下一轮重试，否则这些计数会永远丢掉
    console.error(`[ToolUsageStore] 写入 SQLite 失败（已忽略，本次尝试 ${written} 条）:`, err)
  }
}

/** 仅在未注入 db 时退化为 JSON 写盘（测试场景等），避免永久内存态丢数据 */
async function flushToLegacyJsonFallback(): Promise<void> {
  if (dbAdapter || !cache) return
  try {
    const file = storePath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const flat: ToolUsageMap = {}
    for (const bucket of cache.values()) {
      for (const [toolName, s] of Object.entries(bucket)) {
        const prev = flat[toolName]
        flat[toolName] = prev
          ? {
              count: prev.count + s.count,
              errorCount: prev.errorCount + s.errorCount,
              lastUsedAt: Math.max(prev.lastUsedAt, s.lastUsedAt),
            }
          : s
      }
    }
    await fs.writeFile(file, JSON.stringify(flat), 'utf-8')
  } catch (err) {
    console.error('[ToolUsageStore] 写入降级 JSON 失败（已忽略）:', err)
  }
}

async function flushNow(): Promise<void> {
  if (!dirty) return
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
  if (cache && dailyCache) {
    // 合并 DB + 现有 cache（cache 为准，因缓存里可能是启动瞬间新产生的调用）
    const fromDb = loadFromDb()
    for (const [agentId, bucket] of fromDb.stats) {
      const existing = ensureAgentBucket(cache, agentId)
      for (const [toolName, stat] of Object.entries(bucket)) {
        if (!existing[toolName]) existing[toolName] = stat
      }
    }
    for (const [key, row] of fromDb.daily) {
      if (!dailyCache.has(key)) dailyCache.set(key, row)
    }
  }
  void tryMigrateLegacyJsonIfNeeded()
}

/**
 * 记录一次工具调用。内存累加，延迟合并落盘。
 *
 * @param agentId 归因到的 **Agent 定义 id**（`chronicler`），不是实例 id；
 *                取不到时传 {@link UNKNOWN_AGENT_ID}，不要编一个
 * @param channel 会话所属渠道（`ipc` / `weixin` / `cron` / …，见 `channel-identity.ts`）。
 *                取不到时传 {@link UNKNOWN_CHANNEL}，**不要猜 `ipc`**
 *
 * 统计失败绝不能影响对话，因此不抛异常。
 */
export async function recordToolUsage(
  agentId: string,
  channel: string,
  toolName: string,
  isError = false,
): Promise<void> {
  if (!toolName) return
  await ensureLoaded()
  if (!cache || !dailyCache) return
  const agent = agentId || UNKNOWN_AGENT_ID
  const ch = channel || UNKNOWN_CHANNEL
  const now = Date.now()

  const scope = scopedKey(agent, ch)
  const bucket = ensureAgentBucket(cache, scope)
  const prev = bucket[toolName] ?? { count: 0, errorCount: 0, lastUsedAt: 0 }
  bucket[toolName] = {
    count: prev.count + 1,
    errorCount: prev.errorCount + (isError ? 1 : 0),
    lastUsedAt: now,
  }
  dirtyStats.add(statKey(agent, ch, toolName))

  const day = localDayKey(now)
  const dKey = dailyKey(day, agent, ch, toolName)
  const dPrev = dailyCache.get(dKey)?.stat ?? { count: 0, errorCount: 0, lastUsedAt: 0 }
  dailyCache.set(dKey, {
    day,
    agentId: agent,
    channel: ch,
    toolName,
    stat: {
      count: dPrev.count + 1,
      errorCount: dPrev.errorCount + (isError ? 1 : 0),
      lastUsedAt: now,
    },
  })
  dirtyDaily.add(dKey)

  scheduleSave()
}

/** 读取全部工具用量，跨 Agent 汇总（从未调用过的工具不在其中，由调用方按 0 处理） */
export async function getToolUsage(): Promise<ToolUsageMap> {
  await ensureLoaded()
  const flat: ToolUsageMap = {}
  if (!cache) return flat
  for (const bucket of cache.values()) {
    for (const [toolName, s] of Object.entries(bucket)) {
      const prev = flat[toolName]
      flat[toolName] = prev
        ? {
            count: prev.count + s.count,
            errorCount: prev.errorCount + s.errorCount,
            lastUsedAt: Math.max(prev.lastUsedAt, s.lastUsedAt),
          }
        : { ...s }
    }
  }
  return flat
}

/** 按日统计的覆盖范围（用于如实告知「这段窗口里有没有数据」） */
export interface DailyCoverage {
  /** 最早一天（YYYY-MM-DD）；没有任何按日数据时为 null */
  since: string | null
  /** 最近一天；没有任何按日数据时为 null */
  until: string | null
  /** 保留天数（超过这个天数的窗口，数据已经不完整了） */
  retentionDays: number
}

export async function getDailyCoverage(): Promise<DailyCoverage> {
  await ensureLoaded()
  let since: string | null = null
  let until: string | null = null
  if (!dailyCache) return { since, until, retentionDays: DAILY_RETENTION_DAYS }
  for (const row of dailyCache.values()) {
    if (since === null || row.day < since) since = row.day
    if (until === null || row.day > until) until = row.day
  }
  return { since, until, retentionDays: DAILY_RETENTION_DAYS }
}

export interface GetToolUsageByAgentOptions {
  /** >0 时只统计最近 N 天（含今天）；省略或 0 表示累计 */
  days?: number
}

/** 往「Agent → 工具 → 用量」的普通对象里累加一行 */
function accumulate(out: ToolUsageByAgent, agentId: string, toolName: string, s: ToolUsageStat): void {
  let bucket = out[agentId]
  if (!bucket) {
    bucket = {}
    out[agentId] = bucket
  }
  const prev = bucket[toolName]
  bucket[toolName] = prev
    ? {
        count: prev.count + s.count,
        errorCount: prev.errorCount + s.errorCount,
        lastUsedAt: Math.max(prev.lastUsedAt, s.lastUsedAt),
      }
    : { ...s }
}

/**
 * 读取逐 Agent 的工具用量。
 *
 * `days > 0` 走按日表、`days` 省略走累计表——两个问题、两个来源，
 * 刻意不互相兜底：累计表里混着 V44 之前无法归因的存量，
 * 拿它当「最近 N 天」用，就是 B1 那个坑的复发。
 */
export async function getToolUsageByAgent(
  options: GetToolUsageByAgentOptions = {},
): Promise<ToolUsageByAgent> {
  await ensureLoaded()
  const days = options.days ?? 0
  const out: ToolUsageByAgent = {}

  if (days > 0) {
    const cutoff = dayKeyBefore(days - 1)
    if (!dailyCache) return out
    for (const row of dailyCache.values()) {
      if (row.day < cutoff) continue
      accumulate(out, row.agentId, row.toolName, row.stat)
    }
    return out
  }

  if (!cache) return out
  for (const [scope, bucket] of cache.entries()) {
    // 缓存键是 `agent<sep>channel`；这个读接口按 Agent 汇总，跨渠道相加
    const { agentId } = parseScopedKey(scope)
    for (const [toolName, s] of Object.entries(bucket)) {
      accumulate(out, agentId, toolName, s)
    }
  }
  return out
}

/**
 * 读某个 `(agent, channel)` 切片的「工具 → 最后使用时刻」。P2 工具装载裁剪的输入。
 *
 * **为什么不能拿 `getToolUsageByAgent` 顶替**：那个接口按 Agent **跨渠道相加**
 * （见它的注释），而裁剪的作用域必须是 (agent, channel)——拿跨渠道汇总去排，
 * 就是设计 §5.6.3(a) 里 `evolution` Recall 掉到 32% 的那个错误。
 *
 * 走**累计表**（`tool_usage_stats`）而不是按日表：这里要的是「最后一次用是什么时候」，
 * 一个跨天的排序键，按日表只留 90 天且要聚合。与 `getToolUsageByAgent` 的
 * 「days 走按日、省略走累计」是**同一个语义分叉**，不是两套口径互相兜底。
 * **不猜渠道**：查不到就是空 map，调用方据此 fail-open 到全量（C4 + C8）。
 */
export async function getToolLastUsedByScope(
  agentId: string,
  channel: string,
): Promise<Map<string, number>> {
  await ensureLoaded()
  const out = new Map<string, number>()
  const bucket = cache?.get(scopedKey(agentId, channel))
  if (!bucket) return out
  for (const [toolName, s] of Object.entries(bucket)) {
    if (s.lastUsedAt > 0) out.set(toolName, s.lastUsedAt)
  }
  return out
}

/**
 * 该 `(agent, channel)` 切片里**最早一条**记录的时刻，无记录返回 null。P2 裁剪的「数据够老吗」判据。
 *
 * 为什么不用工具条数当判据（见 `tool-loadout.ts` 的注释）：一个稳定只用 12 个工具的渠道
 * 恰恰是最好的折叠对象，按条数拦会把它永久关在门外。真信号是**渠道数据够不够老**
 * ——渠道维度是后加的，刚上线的渠道计数天然偏低，那时排序必然是瞎猜。
 *
 * 取 `count > 0`：被清扫到 0 的行不算历史（它不代表「那时在用」）。
 */
export async function getScopeHistorySince(
  agentId: string,
  channel: string,
): Promise<number | null> {
  await ensureLoaded()
  const bucket = cache?.get(scopedKey(agentId, channel))
  if (!bucket) return null
  let oldest = Infinity
  for (const s of Object.values(bucket)) {
    if (s.count > 0 && s.lastUsedAt > 0 && s.lastUsedAt < oldest) oldest = s.lastUsedAt
  }
  return Number.isFinite(oldest) ? oldest : null
}

/** 退出前强制落盘，避免丢掉 debounce 窗口内的计数 */
export async function flushToolUsage(): Promise<void> {  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  await flushNow()
}

/** 仅测试用：重置模块内存态 */
export function __resetToolUsageCacheForTest(): void {
  cache = null
  dailyCache = null
  dirtyStats = new Set()
  dirtyDaily = new Set()
  dirty = false
  dbAdapter = null
  migrationDone = false
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}
