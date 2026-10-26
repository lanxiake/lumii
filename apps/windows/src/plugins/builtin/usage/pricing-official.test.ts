/**
 * 内置价目表的「官方价」口径自检。
 *
 * 守三类容易算错、又不容易被肉眼发现的东西：
 * 1. **DeepSeek 分时计价**：高峰 = 北京时间工作日 9-12、14-18 点，闲时半价，周末全天闲时。
 * 2. **分段（阶梯）计价**：按单次请求的输入 token 总量整单落档，不是「超过部分才涨价」。
 * 3. **缓存列不能填反**：Kimi / 智谱 / 百炼的官网页第三列是「缓存命中」，
 *    老表把命中价填进了缓存写，会让命中缓存反而按写入计费。
 */
import { describe, it, expect } from 'vitest'
import { estimateCostYuan } from '../../../shared/model-pricing'

/** 北京时间 → epoch ms */
const bj = (iso: string) => new Date(`${iso}+08:00`).getTime()

const M = 1_000_000

describe('DeepSeek 分时计价', () => {
  it('工作日上午高峰：按高峰价（flash ¥2 入 / ¥8 出）', () => {
    // 2026-10-26 是周一
    const cost = estimateCostYuan('deepseek-flash', { inputTokens: M, outputTokens: M }, bj('2026-10-26T10:00:00'))
    expect(cost).toBe(10)
  })

  it('工作日午休 13 点、晚间 20 点都是闲时：半价', () => {
    for (const t of ['2026-10-26T13:00:00', '2026-10-26T20:00:00']) {
      expect(estimateCostYuan('deepseek-flash', { inputTokens: M, outputTokens: M }, bj(t))).toBe(5)
    }
  })

  it('周末全天闲时（哪怕是上午 10 点）', () => {
    // 2026-10-24 是周六
    expect(estimateCostYuan('deepseek-flash', { inputTokens: M, outputTokens: M }, bj('2026-10-24T10:00:00'))).toBe(5)
  })

  it('不传时间戳按高峰（保守）；旧名 deepseek-v4-flash 同价', () => {
    expect(estimateCostYuan('deepseek-flash', { inputTokens: M, outputTokens: M })).toBe(10)
    expect(estimateCostYuan('deepseek-v4-flash', { inputTokens: M, outputTokens: M })).toBe(10)
    expect(estimateCostYuan('deepseek-v4-flash', { inputTokens: M, outputTokens: M }, bj('2026-10-26T10:00:00'))).toBe(10)
  })

  it('v4-pro：高峰 ¥9/¥27，闲时 ¥4.5/¥13.5', () => {
    expect(estimateCostYuan('deepseek-v4-pro', { inputTokens: M, outputTokens: M }, bj('2026-10-26T10:00:00'))).toBe(36)
    expect(estimateCostYuan('deepseek-v4-pro', { inputTokens: M, outputTokens: M }, bj('2026-10-26T20:00:00'))).toBe(18)
  })
})

describe('分段（阶梯）计价', () => {
  it('qwen3.7-flash 三档按输入量整单落档', () => {
    const at = (inputTokens: number) => estimateCostYuan('qwen3.7-flash', { inputTokens, outputTokens: M })
    expect(at(10_000)).toBeCloseTo(0.01 * 0.2 + 0.8, 6) // ≤32K
    expect(at(100_000)).toBeCloseTo(0.1 * 0.6 + 2.4, 6) // 32K-256K
    expect(at(500_000)).toBeCloseTo(0.5 * 1.2 + 4.8, 6) // 256K-1M
  })

  it('GLM-5.1 在 32K 处换档（¥6/¥24 → ¥8/¥28）', () => {
    const at = (inputTokens: number) => estimateCostYuan('glm-5.1', { inputTokens, outputTokens: M })
    expect(at(10_000)).toBeCloseTo(0.01 * 6 + 24, 6)
    expect(at(40_000)).toBeCloseTo(0.04 * 8 + 28, 6)
  })

  it('Grok 输入超 200K 后整单翻倍', () => {
    const inUsd = (inTok: number) =>
      estimateCostYuan('grok-4.7', { inputTokens: inTok, outputTokens: M }) as number
    expect(inUsd(100_000)).toBeCloseTo(0.1 * 2 * 7.2 + 6 * 7.2, 6)
    expect(inUsd(300_000)).toBeCloseTo(0.3 * 4 * 7.2 + 12 * 7.2, 6)
  })

  it('Claude Haiku 5.5 超过 100K 输入后换贵档', () => {
    const out = (inputTokens: number) =>
      estimateCostYuan('claude-haiku-5-5', { inputTokens, outputTokens: 0 }) as number
    expect(out(50_000)).toBeCloseTo(0.05 * 0.1 * 7.2, 6)
    expect(out(150_000)).toBeCloseTo(0.15 * 0.5 * 7.2, 6)
  })
})

describe('官方单价与缓存列', () => {
  it('Kimi 第三列是缓存命中，不是缓存写', () => {
    // kimi-k2.6 缓存命中 ¥1.1/1M
    expect(estimateCostYuan('kimi-k2.6', { cacheReadTokens: M })).toBeCloseTo(1.1, 6)
    expect(estimateCostYuan('kimi-k2.6', { cacheWriteTokens: M })).toBe(0)
  })

  it('GLM-5.2 缓存命中 ¥2、缓存存储免费', () => {
    expect(estimateCostYuan('glm-5.2', { cacheReadTokens: M })).toBeCloseTo(2, 6)
    expect(estimateCostYuan('glm-5.2', { cacheWriteTokens: M })).toBe(0)
  })

  it('百炼 qwen3.8-flash 用官方 ¥0.8/¥2.7，缓存命中 ¥0.1', () => {
    expect(estimateCostYuan('qwen3.8-flash', { inputTokens: M, outputTokens: M })).toBeCloseTo(3.5, 6)
    expect(estimateCostYuan('qwen3.8-flash', { cacheReadTokens: M })).toBeCloseTo(0.1, 6)
  })

  it('qwen3.8-27b 有价（原先整条缺失）', () => {
    expect(estimateCostYuan('qwen3.8-27b', { inputTokens: M, outputTokens: M })).toBeCloseTo(15, 6)
  })

  it('gpt-5.6-sol 用官方 $4/$20（原 $10/$45 已过期）', () => {
    expect(estimateCostYuan('gpt-5.6-sol', { inputTokens: M, outputTokens: M })).toBeCloseTo(24 * 7.2, 6)
  })

  it('glm-4.5-air 不再被过宽的 glm-4 前缀按 ¥0.14 计', () => {
    // ≤32K 档 ¥0.8 入 / ¥6 出
    expect(estimateCostYuan('glm-4.5-air', { inputTokens: 10_000, outputTokens: M })).toBeCloseTo(0.01 * 0.8 + 6, 6)
  })
})
