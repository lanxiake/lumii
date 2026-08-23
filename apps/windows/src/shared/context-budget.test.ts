/**
 * 上下文预算：区分固定开销与可压缩部分
 *
 * 回归用例取自真实故障日志（MiniMax-M2.7，200K 窗口，MCP 独占 150K）。
 */

import { describe, it, expect } from 'vitest'
import { computeContextBudget, shouldCompactByBudget } from './context-budget'
import type { ContextUsageBreakdownEntry } from './agent-runtime-events'

/** 故障日志实测分布：固定开销 164805，对话仅 9578 */
const REAL_BREAKDOWN: readonly ContextUsageBreakdownEntry[] = [
  { category: 'systemPrompt', tokens: 2229 },
  { category: 'tools', tokens: 10310 },
  { category: 'skills', tokens: 1083 },
  { category: 'mcp', tokens: 150708 },
  { category: 'subagents', tokens: 475 },
  { category: 'dynamicContext', tokens: 1939 },
  { category: 'conversation', tokens: 9578 },
]

describe('computeContextBudget', () => {
  it('MCP 吃掉 83% 窗口时，对话池被压到极窄但仍可压缩', () => {
    const b = computeContextBudget(195915, 200000, REAL_BREAKDOWN, 8192)
    // 固定开销 = 2229+10310+1083+150708+475+1939
    expect(b.fixedOverhead).toBe(166744)
    // 200000 - 166744 - 8192：留给对话的空间只剩 25064
    expect(b.budget).toBe(25064)
    expect(b.exhausted).toBe(false)
    // 实测反推可压缩量 29171 > 25064×0.78 → 应触发压缩（旧口径下这里也触发，
    // 但旧 floor 按整窗算恒真，压完 used 不降，无法判断压缩是否真的有救）
    expect(b.compressible).toBe(29171)
    expect(shouldCompactByBudget(b, 0.78)).toBe(true)
  })

  it('固定开销挤满窗口时判定耗尽：压缩救不了，应提示禁用 server', () => {
    const breakdown: readonly ContextUsageBreakdownEntry[] = [
      { category: 'mcp', tokens: 195000 },
      { category: 'conversation', tokens: 3000 },
    ]
    const b = computeContextBudget(198000, 200000, breakdown, 8192)
    expect(b.exhausted).toBe(true)
    expect(b.budget).toBe(0)
    expect(shouldCompactByBudget(b, 0.78)).toBe(false)
  })

  it('固定开销小时按对话池判断，不再被整窗占用带偏', () => {
    const breakdown: readonly ContextUsageBreakdownEntry[] = [
      { category: 'systemPrompt', tokens: 2000 },
      { category: 'mcp', tokens: 8000 },
      { category: 'conversation', tokens: 100000 },
    ]
    const b = computeContextBudget(110000, 200000, breakdown, 8192)
    expect(b.fixedOverhead).toBe(10000)
    expect(b.compressible).toBe(100000)
    expect(b.budget).toBe(181808)
    expect(b.exhausted).toBe(false)
    // 100000 < 181808×0.78 → 尚无需压缩
    expect(shouldCompactByBudget(b, 0.78)).toBe(false)
  })

  it('对话涨满可压缩预算时触发', () => {
    const breakdown: readonly ContextUsageBreakdownEntry[] = [
      { category: 'mcp', tokens: 10000 },
      { category: 'conversation', tokens: 150000 },
    ]
    const b = computeContextBudget(160000, 200000, breakdown, 8192)
    expect(shouldCompactByBudget(b, 0.78)).toBe(true)
  })

  it('无 breakdown 时退化为整窗口径，不因缺明细而完全不压缩', () => {
    const b = computeContextBudget(180000, 200000, undefined, 8192)
    expect(b.fixedOverhead).toBe(0)
    expect(b.compressible).toBe(180000)
    expect(b.budget).toBe(191808)
    expect(shouldCompactByBudget(b, 0.78)).toBe(true)
  })

  it('实测 used 高于 breakdown 估算时以实测反推可压缩量', () => {
    const breakdown: readonly ContextUsageBreakdownEntry[] = [
      { category: 'mcp', tokens: 10000 },
      { category: 'conversation', tokens: 5000 },
    ]
    // used=60000 说明对话实际约 50000，估算的 5000 偏低
    const b = computeContextBudget(60000, 200000, breakdown, 8192)
    expect(b.compressible).toBe(50000)
  })

  it('缓存命中让 used 偏低时不低于对话估算', () => {
    const breakdown: readonly ContextUsageBreakdownEntry[] = [
      { category: 'mcp', tokens: 10000 },
      { category: 'conversation', tokens: 40000 },
    ]
    const b = computeContextBudget(12000, 200000, breakdown, 8192)
    expect(b.compressible).toBe(40000)
  })

  it('窗口小于补全预留时判定耗尽', () => {
    const b = computeContextBudget(4000, 8000, undefined, 8192)
    expect(b.exhausted).toBe(true)
    expect(shouldCompactByBudget(b, 0.78)).toBe(false)
  })
})
