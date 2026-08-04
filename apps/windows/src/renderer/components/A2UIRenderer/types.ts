/**
 * A2UI 类型定义 — MtBot 组件目录
 */

// ---------------------------------------------------------------
// 基础组件
// ---------------------------------------------------------------

export interface A2UIText {
  type: 'Text'
  id: string
  content: string
  variant?: 'body' | 'caption' | 'heading'
}

export interface A2UICard {
  type: 'Card'
  id: string
  title?: string
  subtitle?: string
  components?: A2UIComponent[]
}

export interface A2UIImage {
  type: 'Image'
  id: string
  src: string
  alt?: string
  width?: number
  height?: number
}

export interface A2UIButton {
  type: 'Button'
  id: string
  label: string
  variant?: 'primary' | 'secondary' | 'outline'
  disabled?: boolean
}

export interface A2UIList {
  type: 'List'
  id: string
  items: A2UIComponent[]
  ordered?: boolean
}

export interface A2UIDivider {
  type: 'Divider'
  id: string
}

// ---------------------------------------------------------------
// 扩展组件
// ---------------------------------------------------------------

export interface A2UIChartDataset {
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

export interface A2UIMathVisualizer {
  type: 'MathVisualizer'
  id: string
  expression: string
  range?: {
    xMin?: number
    xMax?: number
    yMin?: number
    yMax?: number
  }
  animated?: boolean
}

// ---------------------------------------------------------------
// 富媒体组件（Phase 2）
// ---------------------------------------------------------------

export interface A2UIAudioPlayer {
  type: 'AudioPlayer'
  id: string
  src: string
  title?: string
  /** 可选波形可视化（预留，当前版本不启用） */
  waveform?: boolean
}

export interface A2UIVideoPlayer {
  type: 'VideoPlayer'
  id: string
  src: string
  poster?: string
  title?: string
}

export interface A2UIFilePreview {
  type: 'FilePreview'
  id: string
  src: string
  filename: string
  /** 部分模型输出会省略，组件内会回退为 application/octet-stream */
  mimeType?: string
  /** 文件大小（字节），可选 */
  size?: number
  /** 预留 Phase 3 扩展 */
  editable?: boolean
}

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

export type A2UIComponent =
  | A2UIText
  | A2UICard
  | A2UIImage
  | A2UIButton
  | A2UIList
  | A2UIDivider
  | A2UIChart
  | A2UIMathVisualizer
  | A2UIAudioPlayer
  | A2UIVideoPlayer
  | A2UIFilePreview
  | A2UIDataTable

export interface A2UISpec {
  components: A2UIComponent[]
}
