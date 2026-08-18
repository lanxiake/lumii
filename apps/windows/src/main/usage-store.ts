/**
 * 本地用量与花费存储
 *
 * 追加写 `~/.lumii/usage/YYYY-MM.jsonl`，一行一次 LLM 调用。
 * 用 JSONL 而不是 SQLite：只有「追加 + 按时间范围全表扫」两种访问，
 * 按月分片后单文件量级很小，省掉一张表和一套迁移。
 *
 * 花费统一用人民币（元，字段 costYuan）。历史 JSONL 可能存着旧版
 * `costCents`（美分），重算时会忽略，用当前价目表按人民币重新估算。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from './client-data-root'
import { estimateCostYuan } from '../shared/model-pricing'

const log = {
  warn: (...a: unknown[]) => console.warn('[UsageStore]', ...a),
  error: (...a: unknown[]) => console.error('[UsageStore]', ...a),
}

/** 一次 LLM 调用的用量记录（落盘 JSONL 字段） */
export interface UsageRecord {
  /** 调用完成时刻（epoch ms） */
  ts: number
  /** 模型 id，原样记录，便于事后改价重算 */
  model: string
  /** 服务商返回的 inputTokens（不含 cacheRead/cacheWrite 的部分） */
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** 估算花费（人民币元）。价格未知时缺省，UI 显示「—」而不是 0 */
  costYuan?: number
  /** 兼容旧版 JSONL 的字段（不再写入，读取时忽略） */
  costCents?: number
  sessionKey?: string
}

export interface UsageQuery {
  /** 起始时刻（含），epoch ms */
  from: number
  /** 结束时刻（不含），epoch ms */
  to: number
  groupBy: 'hour' | 'day'
}

/** 分桶后的用量聚合 */
export interface UsageBucket {
  /** 桶起始时刻，epoch ms */
  ts: number
  calls: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 桶内已知价格部分的花费合计（人民币元） */
  costYuan: number
  /** 桶内有多少次调用价格未知——有则 UI 需标注「部分未计价」 */
  unpricedCalls: number
  /** 桶内按模型细分（花费降序），堆叠图按它分色 */
  byModel: UsageModelStat[]
}

/** 单个模型的用量聚合，用于图表下方的总结卡片 */
export interface UsageModelStat {
  model: string
  calls: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 已知价格部分的花费合计（人民币元） */
  costYuan: number
  /** 价格未知的调用次数 */
  unpricedCalls: number
}

export interface UsageSummary {
  totalCalls: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCostYuan: number
  unpricedCalls: number
  buckets: UsageBucket[]
  /** 按模型聚合，花费降序。总结卡片用它算「花费最多的模型」等 */
  byModel: UsageModelStat[]
}

function usageDir(): string {
  return path.join(resolveWindowsClientDataRoot(), 'usage')
}

/** 按本地时间分片，与用户看到的「本月」一致 */
function shardName(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`
}

/** 枚举 [from, to] 跨越的所有月份分片文件名 */
function shardsInRange(from: number, to: number): string[] {
  const names: string[] = []
  const cursor = new Date(from)
  cursor.setDate(1)
  cursor.setHours(0, 0, 0, 0)
  while (cursor.getTime() <= to) {
    names.push(shardName(cursor.getTime()))
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return names
}

/** 桶起始时刻：按本地小时 / 本地日对齐 */
function bucketStart(ts: number, groupBy: 'hour' | 'day'): number {
  const d = new Date(ts)
  d.setMinutes(0, 0, 0)
  if (groupBy === 'day') d.setHours(0)
  return d.getTime()
}

/**
 * 记录一次 LLM 调用。costYuan 由模型 id + 时间戳 + token 明细现场估算。
 *
 * 用量统计失败绝不能影响对话，因此内部吞掉所有异常只打日志。
 */
export async function recordUsage(input: {
  model: string
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  sessionKey?: string
  ts?: number
}): Promise<void> {
  const ts = input.ts ?? Date.now()
  const costYuan = estimateCostYuan(
    input.model,
    {
      inputTokens: input.promptTokens,
      outputTokens: input.completionTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
    },
    ts,
  )
  const record: UsageRecord = {
    ts,
    model: input.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    ...(input.cacheReadTokens ? { cacheReadTokens: input.cacheReadTokens } : {}),
    ...(input.cacheWriteTokens ? { cacheWriteTokens: input.cacheWriteTokens } : {}),
    ...(costYuan !== undefined ? { costYuan } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
  }
  try {
    const dir = usageDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(path.join(dir, shardName(ts)), `${JSON.stringify(record)}\n`, 'utf-8')
  } catch (err) {
    log.error('写入用量记录失败（已忽略，不影响对话）:', err)
  }
}

/** 读一个月分片；文件不存在返回空数组。兼容旧版字段（缺省值置 0） */
async function readShard(name: string): Promise<UsageRecord[]> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(usageDir(), name), 'utf-8')
  } catch {
    return []
  }
  const out: UsageRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as UsageRecord
      if (typeof rec.ts === 'number' && typeof rec.model === 'string') {
        // 历史记录缺省时补 0，后续重算不依赖这些字段也能跑通
        if (typeof rec.promptTokens !== 'number') rec.promptTokens = 0
        if (typeof rec.completionTokens !== 'number') rec.completionTokens = 0
        out.push(rec)
      }
    } catch {
      // 单行损坏（例如上次写入被强杀截断）跳过即可，不让整月查询失败
      log.warn(`跳过损坏的用量记录行: ${line.slice(0, 80)}`)
    }
  }
  return out
}

/** 按时间范围聚合用量。空区间返回全 0 且 buckets 为空，由 UI 显示空状态 */
export async function queryUsage(query: UsageQuery): Promise<UsageSummary> {
  const { from, to, groupBy } = query
  const shards = await Promise.all(shardsInRange(from, to).map(readShard))

  const buckets = new Map<number, UsageBucket>()
  const bucketModels = new Map<number, Map<string, UsageModelStat>>()
  const models = new Map<string, UsageModelStat>()
  const summary: UsageSummary = {
    totalCalls: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCostYuan: 0,
    unpricedCalls: 0,
    buckets: [],
    byModel: [],
  }

  for (const rec of shards.flat()) {
    if (rec.ts < from || rec.ts >= to) continue
    // 查询时按当前价目表 + 真实调用时间戳 重算：
    // 历史记录可能缺 costYuan（或为旧版 costCents），或价目表已更新
    const costYuan = estimateCostYuan(
      rec.model,
      {
        inputTokens: rec.promptTokens,
        outputTokens: rec.completionTokens,
        cacheReadTokens: rec.cacheReadTokens,
        cacheWriteTokens: rec.cacheWriteTokens,
      },
      rec.ts,
    )

    const key = bucketStart(rec.ts, groupBy)
    const bucket = buckets.get(key) ?? {
      ts: key,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costYuan: 0,
      unpricedCalls: 0,
      byModel: [],
    }
    bucket.calls += 1
    bucket.promptTokens += rec.promptTokens
    bucket.completionTokens += rec.completionTokens
    bucket.cacheReadTokens += rec.cacheReadTokens ?? 0
    bucket.cacheWriteTokens += rec.cacheWriteTokens ?? 0
    if (costYuan === undefined) bucket.unpricedCalls += 1
    else bucket.costYuan += costYuan
    buckets.set(key, bucket)

    const bm = bucketModels.get(key) ?? new Map<string, UsageModelStat>()
    const bstat = bm.get(rec.model) ?? {
      model: rec.model,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costYuan: 0,
      unpricedCalls: 0,
    }
    bstat.calls += 1
    bstat.promptTokens += rec.promptTokens
    bstat.completionTokens += rec.completionTokens
    bstat.cacheReadTokens += rec.cacheReadTokens ?? 0
    bstat.cacheWriteTokens += rec.cacheWriteTokens ?? 0
    if (costYuan === undefined) bstat.unpricedCalls += 1
    else bstat.costYuan += costYuan
    bm.set(rec.model, bstat)
    bucketModels.set(key, bm)

    const stat = models.get(rec.model) ?? {
      model: rec.model,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costYuan: 0,
      unpricedCalls: 0,
    }
    stat.calls += 1
    stat.promptTokens += rec.promptTokens
    stat.completionTokens += rec.completionTokens
    stat.cacheReadTokens += rec.cacheReadTokens ?? 0
    stat.cacheWriteTokens += rec.cacheWriteTokens ?? 0
    if (costYuan === undefined) stat.unpricedCalls += 1
    else stat.costYuan += costYuan
    models.set(rec.model, stat)

    summary.totalCalls += 1
    summary.totalPromptTokens += rec.promptTokens
    summary.totalCompletionTokens += rec.completionTokens
    summary.totalCacheReadTokens += rec.cacheReadTokens ?? 0
    summary.totalCacheWriteTokens += rec.cacheWriteTokens ?? 0
    if (costYuan === undefined) summary.unpricedCalls += 1
    else summary.totalCostYuan += costYuan
  }

  const round = (c: number) => Math.round(c * 1_000_000) / 1_000_000
  const byCostDesc = (a: UsageModelStat, b: UsageModelStat) =>
    b.costYuan - a.costYuan || b.calls - a.calls
  summary.totalCostYuan = round(summary.totalCostYuan)
  summary.buckets = [...buckets.values()].sort((a, b) => a.ts - b.ts).map((b) => ({
    ...b,
    byModel: [...(bucketModels.get(b.ts)?.values() ?? [])]
      .map((m) => ({ ...m, costYuan: round(m.costYuan) }))
      .sort(byCostDesc),
  }))
  summary.byModel = [...models.values()]
    .map((m) => ({ ...m, costYuan: round(m.costYuan) }))
    .sort(byCostDesc)
  return summary
}
