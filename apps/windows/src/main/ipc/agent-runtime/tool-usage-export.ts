import type { ToolUsageMap } from '../../tool-usage-store'

/** 导出文件中单个工具的一行 */
export interface ToolUsageExportRow {
  name: string
  count: number
  errorCount: number
  lastUsedAt: number
}

/** 导出文件中按 Agent 的一块 */
export interface ToolUsageExportAgent {
  id: string
  name: string
  totalCalls: number
  tools: readonly ToolUsageExportRow[]
}

/** 工具使用记录导出载荷（便于离线分析 / 优化工具面） */
export interface ToolUsageExportPayload {
  exportedAt: number
  byAgent: readonly ToolUsageExportAgent[]
  totals: readonly ToolUsageExportRow[]
}

/**
 * 组装工具使用记录导出 JSON 对象。
 * totals 按调用次数降序、同次数按名称升序，与「按 Agent」视图排序口径一致。
 */
export function buildToolUsageExportPayload(input: {
  exportedAt: number
  byAgent: readonly ToolUsageExportAgent[]
  totals: ToolUsageMap
}): ToolUsageExportPayload {
  const totals = Object.entries(input.totals)
    .map(([name, s]) => ({
      name,
      count: s.count,
      errorCount: s.errorCount,
      lastUsedAt: s.lastUsedAt,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  return {
    exportedAt: input.exportedAt,
    byAgent: input.byAgent,
    totals,
  }
}
