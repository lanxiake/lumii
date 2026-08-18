/**
 * 本地用量存储测试
 *
 * 覆盖：写入-查询闭环、时间范围过滤、分桶、以及「价格未知不计 0」这条底线。
 * 花费口径已统一为人民币（元），字段 costYuan。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/lumii-test' }, shell: {} }))

let dataRoot: string

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-usage-'))
  process.env.LUMII_CLIENT_DATA_DIR = dataRoot
  // client-data-root 在进程内缓存根目录，必须重置模块才能让新的 env 生效
  vi.resetModules()
})

afterEach(async () => {
  delete process.env.LUMII_CLIENT_DATA_DIR
  await fs.rm(dataRoot, { recursive: true, force: true })
})

async function store() {
  return import('./usage-store')
}

const DAY = 86_400_000

describe('usage-store', () => {
  it('写入后能查回，token 与花费都累加（人民币口径）', async () => {
    const { recordUsage, queryUsage } = await store()
    const now = Date.now()
    // gpt-4o-mini：文档中 input $0.15/M、output $0.6/M，折算汇率 7.2 → ¥1.08/M 入、¥4.32/M 出
    await recordUsage({ model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 500, ts: now })
    await recordUsage({ model: 'gpt-4o-mini', promptTokens: 2000, completionTokens: 1000, ts: now })

    const r = await queryUsage({ from: now - DAY, to: now + DAY, groupBy: 'day' })
    expect(r.totalCalls).toBe(2)
    expect(r.totalPromptTokens).toBe(3000)
    expect(r.totalCompletionTokens).toBe(1500)
    // 3000/1M * 1.08 + 1500/1M * 4.32 = 0.00324 + 0.00648 = 0.00972 元
    expect(r.totalCostYuan).toBeCloseTo(0.00972, 6)
    expect(r.unpricedCalls).toBe(0)
  })

  it('范围外的记录不计入', async () => {
    const { recordUsage, queryUsage } = await store()
    const now = Date.now()
    await recordUsage({ model: 'gpt-4o', promptTokens: 100, completionTokens: 100, ts: now })
    const r = await queryUsage({ from: now + 1, to: now + DAY, groupBy: 'day' })
    expect(r.totalCalls).toBe(0)
    expect(r.buckets).toHaveLength(0)
  })

  it('未知模型只记 token，不把花费当 0', async () => {
    const { recordUsage, queryUsage } = await store()
    const now = Date.now()
    await recordUsage({ model: 'some-unlisted-model', promptTokens: 900, completionTokens: 100, ts: now })
    const r = await queryUsage({ from: now - DAY, to: now + DAY, groupBy: 'day' })
    expect(r.totalPromptTokens).toBe(900)
    expect(r.unpricedCalls).toBe(1)
    expect(r.totalCostYuan).toBe(0)
  })

  it('本地模型计 0 花费，且不算「未计价」', async () => {
    const { recordUsage, queryUsage } = await store()
    const now = Date.now()
    await recordUsage({ model: 'ollama/qwen3:8b', promptTokens: 500, completionTokens: 500, ts: now })
    const r = await queryUsage({ from: now - DAY, to: now + DAY, groupBy: 'day' })
    expect(r.totalCostYuan).toBe(0)
    expect(r.unpricedCalls).toBe(0)
  })

  it('按小时分桶：同小时合并，跨小时分开', async () => {
    const { recordUsage, queryUsage } = await store()
    const base = new Date()
    base.setMinutes(5, 0, 0)
    const t1 = base.getTime()
    const t2 = t1 + 10 * 60_000 // 同一小时
    const t3 = t1 + 60 * 60_000 // 下一小时
    for (const ts of [t1, t2, t3]) {
      await recordUsage({ model: 'gpt-4o', promptTokens: 10, completionTokens: 10, ts })
    }
    const r = await queryUsage({ from: t1 - DAY, to: t3 + DAY, groupBy: 'hour' })
    expect(r.buckets).toHaveLength(2)
    expect(r.buckets[0].calls).toBe(2)
    expect(r.buckets[1].calls).toBe(1)
  })

  it('损坏的行被跳过，不影响整月查询', async () => {
    const { recordUsage, queryUsage } = await store()
    const now = Date.now()
    await recordUsage({ model: 'gpt-4o', promptTokens: 10, completionTokens: 10, ts: now })
    const d = new Date(now)
    const shard = path.join(
      dataRoot,
      'usage',
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`,
    )
    await fs.appendFile(shard, '{"ts":broken\n', 'utf-8')
    const r = await queryUsage({ from: now - DAY, to: now + DAY, groupBy: 'day' })
    expect(r.totalCalls).toBe(1)
  })

  it('桶内按模型细分：同桶多模型分开统计，按花费降序', async () => {
    const { recordUsage, queryUsage } = await store()
    const now = Date.now()
    await recordUsage({ model: 'gpt-4o', promptTokens: 100, completionTokens: 50, ts: now })
    await recordUsage({ model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 500, ts: now })
    await recordUsage({ model: 'gpt-4o-mini', promptTokens: 2000, completionTokens: 1000, ts: now })

    const r = await queryUsage({ from: now - DAY, to: now + DAY, groupBy: 'day' })
    expect(r.buckets).toHaveLength(1)
    const byModel = r.buckets[0].byModel
    expect(byModel).toHaveLength(2)
    // gpt-4o-mini 调用更多 token → 花费更高 → 降序排首位
    expect(byModel[0].model).toBe('gpt-4o-mini')
    expect(byModel[0].calls).toBe(2)
    expect(byModel[0].promptTokens).toBe(3000)
    expect(byModel[0].completionTokens).toBe(1500)
    expect(byModel[1].model).toBe('gpt-4o')
    expect(byModel[1].calls).toBe(1)
  })

  it('没有任何记录时返回全 0 空桶，而不是抛错', async () => {
    const { queryUsage } = await store()
    const now = Date.now()
    const r = await queryUsage({ from: now - DAY, to: now, groupBy: 'day' })
    expect(r).toMatchObject({ totalCalls: 0, totalCostYuan: 0, unpricedCalls: 0 })
    expect(r.buckets).toEqual([])
  })

  it('cacheRead / cacheWrite token 也会参与计费（以 claude-opus-4 为例）', async () => {
    const { recordUsage, queryUsage } = await store()
    const now = Date.now()
    // claude-opus-4: 入 $5 出 $25 cr $0.5 cw $6.25 → 汇率 7.2
    // 入 ¥36/M 出 ¥180/M cr(读) ¥3.6/M cw(写) ¥45/M
    await recordUsage({
      model: 'claude-opus-4-8',
      promptTokens: 1_000_000, // input 未命中 = ¥36
      completionTokens: 500_000, // 输出 = ¥90
      cacheReadTokens: 2_000_000, // cache 读 = 2 * ¥3.6 = ¥7.2
      cacheWriteTokens: 0,
      ts: now,
    })
    const r = await queryUsage({ from: now - DAY, to: now + DAY, groupBy: 'day' })
    // 合计：36 + 90 + 7.2 = 133.2 元
    expect(r.totalCostYuan).toBeCloseTo(133.2, 4)
    expect(r.totalCacheReadTokens).toBe(2_000_000)
    expect(r.unpricedCalls).toBe(0)
  })
})
