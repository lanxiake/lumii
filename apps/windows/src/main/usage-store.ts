/**
 * 本地用量与花费存储（Task 4.3）
 *
 * 追加写 `~/.lumii/usage/YYYY-MM.jsonl`，一行一次 LLM 调用。
 * 用 JSONL 而不是 SQLite：只有「追加 + 按时间范围全表扫」两种访问，
 * 按月分片后单文件量级很小，省掉一张表和一套迁移。
 *
 * ponytail: 查询是整月文件全读全解析，月内几十万行以内够用；
 * 真要更快再上 SQLite 或按天分片。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from './client-data-root'
import { estimateCostCents } from '../shared/model-pricing'

const log = {
  warn: (...a: unknown[]) => console.warn('[UsageStore]', ...a),
  error: (...a: unknown[]) => console.error('[UsageStore]', ...a),
}

/** 一次 LLM 调用的用量记录 */
export interface UsageRecord {
  /** 调用完成时刻（epoch ms） */
  ts: number
  /** 模型 id，原样记录，便于事后改价重算 */
  model: string
  promptTokens: number
  completionTokens: number
  /** 估算花费（美分）。价格未知时缺省，UI 显示「—」而不是 0 */
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
  /** 桶内已知价格部分的花费合计（美分） */
  costCents: number
  /** 桶内有多少次调用价格未知——有则 UI 需标注「部分未计价」 */
  unpricedCalls: number
}

export interface UsageSummary {
  totalCalls: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCostCents: number
  unpricedCalls: number
  buckets: UsageBucket[]
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
 * 记录一次 LLM 调用。costCents 由模型 id 现场估算。
 *
 * 用量统计失败绝不能影响对话，因此内部吞掉所有异常只打日志。
 */
export async function recordUsage(input: {
  model: string
  promptTokens: number
  completionTokens: number
  sessionKey?: string
  ts?: number
}): Promise<void> {
  const ts = input.ts ?? Date.now()
  const costCents = estimateCostCents(input.model, input.promptTokens, input.completionTokens)
  const record: UsageRecord = {
    ts,
    model: input.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    ...(costCents !== undefined ? { costCents } : {}),
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

/** 读一个月分片；文件不存在返回空数组 */
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
      if (typeof rec.ts === 'number' && typeof rec.model === 'string') out.push(rec)
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
  const summary: UsageSummary = {
    totalCalls: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCostCents: 0,
    unpricedCalls: 0,
    buckets: [],
  }

  for (const rec of shards.flat()) {
    if (rec.ts < from || rec.ts >= to) continue
    // 查询时按当前价目表重算：历史记录可能缺 costCents，或价目表已更新
    const costCents = estimateCostCents(rec.model, rec.promptTokens, rec.completionTokens)
    const key = bucketStart(rec.ts, groupBy)
    const bucket = buckets.get(key) ?? {
      ts: key,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      costCents: 0,
      unpricedCalls: 0,
    }
    bucket.calls += 1
    bucket.promptTokens += rec.promptTokens
    bucket.completionTokens += rec.completionTokens
    if (costCents === undefined) bucket.unpricedCalls += 1
    else bucket.costCents += costCents
    buckets.set(key, bucket)

    summary.totalCalls += 1
    summary.totalPromptTokens += rec.promptTokens
    summary.totalCompletionTokens += rec.completionTokens
    if (costCents === undefined) summary.unpricedCalls += 1
    else summary.totalCostCents += costCents
  }

  summary.totalCostCents = Math.round(summary.totalCostCents * 10_000) / 10_000
  summary.buckets = [...buckets.values()].sort((a, b) => a.ts - b.ts)
  return summary
}
