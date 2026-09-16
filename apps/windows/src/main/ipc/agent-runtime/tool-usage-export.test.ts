import { describe, it, expect } from 'vitest'
import { buildToolUsageExportPayload } from './tool-usage-export'

describe('buildToolUsageExportPayload', () => {
  it('组装带时间戳、按 Agent 明细与全局合计的导出载荷', () => {
    const payload = buildToolUsageExportPayload({
      exportedAt: 1_700_000_000_000,
      byAgent: [
        {
          id: 'main',
          name: '主助手',
          totalCalls: 5,
          tools: [
            { name: 'file_read', count: 3, errorCount: 0, lastUsedAt: 100 },
            { name: 'file_write', count: 2, errorCount: 1, lastUsedAt: 200 },
          ],
        },
      ],
      totals: {
        file_read: { count: 3, errorCount: 0, lastUsedAt: 100 },
        file_write: { count: 2, errorCount: 1, lastUsedAt: 200 },
      },
    })

    expect(payload.exportedAt).toBe(1_700_000_000_000)
    expect(payload.byAgent).toHaveLength(1)
    expect(payload.byAgent[0]!.tools[0]!.name).toBe('file_read')
    expect(payload.totals).toEqual([
      { name: 'file_read', count: 3, errorCount: 0, lastUsedAt: 100 },
      { name: 'file_write', count: 2, errorCount: 1, lastUsedAt: 200 },
    ])
  })

  it('totals 按调用次数降序，同次数按名称升序', () => {
    const payload = buildToolUsageExportPayload({
      exportedAt: 1,
      byAgent: [],
      totals: {
        zeta: { count: 2, errorCount: 0, lastUsedAt: 0 },
        alpha: { count: 2, errorCount: 0, lastUsedAt: 0 },
        beta: { count: 9, errorCount: 0, lastUsedAt: 0 },
      },
    })
    expect(payload.totals.map(t => t.name)).toEqual(['beta', 'alpha', 'zeta'])
  })
})
