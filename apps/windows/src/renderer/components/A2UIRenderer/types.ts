/**
 * A2UI 组件类型定义
 *
 * 只剩 Chart / DataTable —— 收敛理由见 `validate.ts` 顶部注释。
 */

// ---------------------------------------------------------------
// Chart
// ---------------------------------------------------------------

interface A2UIChartDataset {
  label: string
  values: number[]
}

export interface A2UIChart {
  type: 'Chart'
  id: string
  chartType: 'line' | 'bar' | 'pie' | 'scatter' | 'area'
  title?: string
  data: {
    labels: string[]
    datasets: A2UIChartDataset[]
  }
}

// ---------------------------------------------------------------
// DataTable
// ---------------------------------------------------------------

export interface A2UIDataTableColumn {
  key: string
  label: string
  sortable?: boolean
}

export interface A2UIDataTable {
  type: 'DataTable'
  id: string
  columns: A2UIDataTableColumn[]
  rows: Record<string, unknown>[]
  /** 每页行数（默认 20） */
  pageSize?: number
  /** 是否启用列筛选 */
  filterable?: boolean
}

// ---------------------------------------------------------------
// 联合类型
// ---------------------------------------------------------------

export type A2UIComponent = A2UIChart | A2UIDataTable

export interface A2UISpec {
  components: A2UIComponent[]
}
