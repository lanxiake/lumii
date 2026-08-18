import { describe, expect, it } from 'vitest'
import { sessionMetrics } from './session-metrics'

const u = (inputTokens: number, outputTokens: number, cacheRead?: number, cacheWrite?: number) => ({
  usage: { inputTokens, outputTokens, cacheRead, cacheWrite },
})

describe('sessionMetrics', () => {
  it('空会话返回全零且无价格', () => {
    expect(sessionMetrics([], 'gpt-4o')).toEqual({
      upTokens: 0,
      downTokens: 0,
      costYuan: 0,
      hasPrice: false,
    })
  })

  it('跳过没有 usage 回执的消息', () => {
    const out = sessionMetrics([{}, u(10, 20), {}], null)
    expect(out.upTokens).toBe(10)
    expect(out.downTokens).toBe(20)
  })

  it('累加多条消息的上下行 token', () => {
    const out = sessionMetrics([u(10, 20), u(5, 7)], null)
    expect(out.upTokens).toBe(15)
    expect(out.downTokens).toBe(27)
  })

  it('modelId 为 null 时只记 token 不记花费', () => {
    const out = sessionMetrics([u(1000, 1000)], null)
    expect(out.hasPrice).toBe(false)
    expect(out.costYuan).toBe(0)
  })

  it('未知模型不计价，token 照记', () => {
    const out = sessionMetrics([u(1000, 1000)], 'no-such-model-xyz')
    expect(out.upTokens).toBe(1000)
    expect(out.hasPrice).toBe(false)
    expect(out.costYuan).toBe(0)
  })

  it('已知模型计出正花费（人民币口径）', () => {
    const out = sessionMetrics([u(100_000, 100_000)], 'gpt-4o')
    expect(out.hasPrice).toBe(true)
    expect(out.costYuan).toBeGreaterThan(0)
  })

  // 本机推理是「免费」，不是「价格未知」——UI 该显示 ¥0.000 而不是「—」
  it('本地模型花费为 0 但 hasPrice 为真', () => {
    const out = sessionMetrics([u(100_000, 100_000)], 'ollama/qwen3:8b')
    expect(out.hasPrice).toBe(true)
    expect(out.costYuan).toBe(0)
  })

  it('cacheRead / cacheWrite token 也计入花费', () => {
    // claude-opus-4: cacheRead 单独定价 ¥3.6/M
    const base = sessionMetrics([u(100_000, 0, 0, 0)], 'claude-opus-4-7')
    const withCache = sessionMetrics(
      [u(100_000, 0, 500_000, 0)],
      'claude-opus-4-7',
    )
    expect(withCache.hasPrice).toBe(true)
    expect(withCache.costYuan).toBeGreaterThan(base.costYuan)
    // 差额应 ≈ 500K cacheRead × ¥3.6/M = ¥1.8
    expect(withCache.costYuan - base.costYuan).toBeCloseTo(1.8, 3)
  })
})
