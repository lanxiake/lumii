/**
 * 自定义模型价格：覆盖内置表 + 恢复官方价 + 落盘往返。
 *
 * 守的是「用户填的价就是算钱用的价」这条：填进去 → 花费按新价重算 →
 * 「恢复官方价」删掉覆盖 → 回到内置表。以及坏输入不能污染内存表。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  estimateCostYuan,
  getPriceOverrides,
  setPriceOverrides,
} from '../../../shared/model-pricing'
import { loadPriceOverrides, savePriceOverrides } from './price-store'

describe('自定义模型价格', () => {
  let tmpFile: string

  beforeEach(() => {
    setPriceOverrides({})
    tmpFile = path.join(os.tmpdir(), `lumii-prices-${process.pid}-${Date.now()}.json`)
  })

  afterEach(() => {
    setPriceOverrides({})
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      // 没写成功就没这个文件，正常
    }
  })

  it('自定义价覆盖内置价：同一模型的花费按自定义单价算', () => {
    // gpt-5.4 官方 $2.5/$15 → ¥18/¥108 每百万。自定义成 ¥1/¥2
    const before = estimateCostYuan('gpt-5.4', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(before).toBeGreaterThan(100) // 官方价算出来是 126 元

    setPriceOverrides({
      'gpt-5.4': { inputYuanPerMTok: 1, outputYuanPerMTok: 2 },
    })

    const after = estimateCostYuan('gpt-5.4', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(after).toBe(3) // 1 + 2
  })

  it('自定义价也认「模型 id 里含前缀」这种写法（与内置表同口径）', () => {
    setPriceOverrides({ 'my-gateway': { inputYuanPerMTok: 0.5, outputYuanPerMTok: 1.5 } })
    const cost = estimateCostYuan('openai/my-gateway-fast', {
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost).toBe(2.5) // 0.5*2 + 1.5
  })

  it('按次计费：填了 perCallYuan 就按次算，忽略 token', () => {
    setPriceOverrides({ 'my-image': { inputYuanPerMTok: 0, outputYuanPerMTok: 0, perCallYuan: 0.3 } })
    expect(estimateCostYuan('my-image-v2', { inputTokens: 999_999, callCount: 2 })).toBe(0.6)
  })

  it('坏条目整条丢弃，不污染已有的合法价', () => {
    setPriceOverrides({
      good: { inputYuanPerMTok: 1, outputYuanPerMTok: 2 },
      bad_negative: { inputYuanPerMTok: -1, outputYuanPerMTok: 2 },
      bad_text: { inputYuanPerMTok: 'x', outputYuanPerMTok: 2 },
      bad_missing: { inputYuanPerMTok: 1 },
    })
    expect(Object.keys(getPriceOverrides())).toEqual(['good'])
    expect(estimateCostYuan('bad_negative-model', { inputTokens: 1_000_000 })).toBeUndefined()
  })

  it('自定义价命中时不再套 DeepSeek 峰谷价（那是内置表的规则）', () => {
    setPriceOverrides({ 'deepseek-v4-pro': { inputYuanPerMTok: 2, outputYuanPerMTok: 4 } })
    // 闲时时间戳：内置表会给半价，自定义价应原样生效
    const offpeak = new Date('2026-03-01T20:00:00+08:00').getTime()
    expect(estimateCostYuan('deepseek-v4-pro', { inputTokens: 1_000_000 }, offpeak)).toBe(2)
  })

  it('落盘再读回：自定义价能跨重启保留；文件不存在时退回内置表', () => {
    savePriceOverrides({ 'my-things': { inputYuanPerMTok: 3, outputYuanPerMTok: 7 } }, tmpFile)
    expect(fs.existsSync(tmpFile)).toBe(true)

    // 清空内存后从磁盘读回来
    setPriceOverrides({})
    expect(getPriceOverrides()).toEqual({})
    loadPriceOverrides(tmpFile)
    expect(getPriceOverrides()).toEqual({ 'my-things': { inputYuanPerMTok: 3, outputYuanPerMTok: 7 } })

    // 文件不存在 = 空表（退回内置价），不抛
    setPriceOverrides({ 'stale': { inputYuanPerMTok: 1, outputYuanPerMTok: 1 } })
    loadPriceOverrides(path.join(os.tmpdir(), 'definitely-not-here-lumii.json'))
    expect(getPriceOverrides()).toEqual({})
  })

  it('坏文件按空表处理，不抛（否则用量面板会打不开）', () => {
    fs.writeFileSync(tmpFile, '{ not json', 'utf-8')
    expect(() => loadPriceOverrides(tmpFile)).not.toThrow()
    expect(getPriceOverrides()).toEqual({})
  })
})
