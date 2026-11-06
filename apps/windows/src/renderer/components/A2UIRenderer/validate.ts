/**
 * A2UI 规格规范化 —— 模型输出不可信的**唯一**收口。
 *
 * 模型给的 JSON 只保证"是 JSON"，不保证字段齐全、类型正确、规模可控：
 * `data.labels` 写成字符串、`rows` 缺失、`values` 里混进 null 都会在渲染期抛
 * TypeError，而渲染期异常会顺 React 树冒到全应用的根错误边界（详见
 * `PluginErrorBoundary` 的注释）。所以在**进入渲染之前**把规格收窄成已知形状，
 * 收不动的整块丢弃，而不是让组件自己防御。
 *
 * 只保留 Chart / DataTable：其余组件（FilePreview / Image / Button / MathVisualizer…）
 * 要么有更强且已接线的既有实现（文件预览走 FilePreviewModal、图片走 markdown，
 * 公式走 KaTeX），要么根本没有回传通道（Button），再加上实现本身的缺陷，已整体下线。
 */

import type { A2UIChart, A2UIComponent, A2UIDataTable, A2UISpec } from './types'

/** 规模上限：模型输出大数组时避免主线程被 recharts / 排序卡住 */
export const A2UI_LIMITS = {
  /** 单个 Chart 的点数（labels 长度） */
  maxPoints: 2000,
  /** 单个 DataTable 的行数 */
  maxRows: 5000,
  /** 表格列数 */
  maxColumns: 50,
  /** 单条消息内最多渲染的组件数 */
  maxComponents: 20,
} as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 数值收窄：接受 number 与数字字符串（模型常把数字写成字符串），其余返回 null */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function toOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * 图表数据收窄。
 *
 * 不合法就返回 `null`（整张图不渲染），而不是补零——补零会画出一张"看起来有数据"
 * 的错图，比不显示更糟。
 */
export function normalizeChartData(
  raw: unknown,
): { labels: string[]; datasets: { label: string; values: number[] }[] } | null {
  if (!isRecord(raw)) return null
  const labelsRaw = raw.labels
  const datasetsRaw = raw.datasets
  if (!Array.isArray(labelsRaw) || !Array.isArray(datasetsRaw)) return null
  if (labelsRaw.length === 0 || datasetsRaw.length === 0) return null

  const labels = labelsRaw
    .slice(0, A2UI_LIMITS.maxPoints)
    .map((l) => (typeof l === 'string' ? l : String(l ?? '')))

  const datasets: { label: string; values: number[] }[] = []
  for (const ds of datasetsRaw) {
    if (!isRecord(ds)) continue
    const label = typeof ds.label === 'string' && ds.label ? ds.label : `系列${datasets.length + 1}`
    const valuesRaw = ds.values
    if (!Array.isArray(valuesRaw)) continue
    // 值必须是有限数字：跳过坏点会错位，所以整条数据集坏掉就不收
    const values: number[] = []
    let ok = true
    for (let i = 0; i < labels.length; i++) {
      const n = toFiniteNumber(valuesRaw[i] ?? 0)
      if (n === null) {
        ok = false
        break
      }
      values.push(n)
    }
    if (!ok) continue
    datasets.push({ label, values })
  }

  if (datasets.length === 0) return null
  return { labels, datasets }
}

const CHART_TYPES = new Set(['line', 'bar', 'pie', 'scatter', 'area'])

/** Chart 组件收窄 */
export function normalizeChart(raw: unknown): A2UIChart | null {
  if (!isRecord(raw)) return null
  const chartType = typeof raw.chartType === 'string' ? raw.chartType : ''
  if (!CHART_TYPES.has(chartType)) return null
  const data = normalizeChartData(raw.data)
  if (!data) return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id : 'chart'
  return {
    type: 'Chart',
    id,
    chartType: chartType as A2UIChart['chartType'],
    title: toOptionalString(raw.title),
    data,
  }
}

/** DataTable 组件收窄 */
export function normalizeDataTable(raw: unknown): A2UIDataTable | null {
  if (!isRecord(raw)) return null
  const columnsRaw = raw.columns
  const rowsRaw = raw.rows
  if (!Array.isArray(columnsRaw) || !Array.isArray(rowsRaw)) return null

  const columns: A2UIDataTable['columns'] = []
  for (const col of columnsRaw.slice(0, A2UI_LIMITS.maxColumns)) {
    if (!isRecord(col)) continue
    const key = typeof col.key === 'string' ? col.key : ''
    if (!key) continue
    columns.push({
      key,
      label: typeof col.label === 'string' && col.label ? col.label : key,
      sortable: col.sortable === true,
    })
  }
  if (columns.length === 0) return null

  const rows: Record<string, unknown>[] = []
  for (const row of rowsRaw.slice(0, A2UI_LIMITS.maxRows)) {
    // 行必须是对象；标量行没有列可映射，直接丢
    if (isRecord(row)) rows.push(row)
  }
  if (rows.length === 0) return null

  const pageSizeRaw = toFiniteNumber(raw.pageSize)
  const pageSize =
    pageSizeRaw && pageSizeRaw > 0 ? Math.min(Math.floor(pageSizeRaw), 200) : undefined

  return {
    type: 'DataTable',
    id: typeof raw.id === 'string' && raw.id ? raw.id : 'table',
    columns,
    rows,
    pageSize,
    filterable: raw.filterable === true,
  }
}

/** 单个组件收窄：不认识的类型返回 null（渲染层不再有 fallback 分支） */
export function normalizeComponent(raw: unknown): A2UIComponent | null {
  if (!isRecord(raw)) return null
  switch (raw.type) {
    case 'Chart':
      return normalizeChart(raw)
    case 'DataTable':
      return normalizeDataTable(raw)
    default:
      return null
  }
}

/**
 * 整条规格收窄：过滤掉无效组件，补稳定 id。
 *
 * id 用「下标路径」而不是随机 UUID：规格每次解析都会重建，随机 id 会让子树 key
 * 每次变，Table 的排序/页码随之重置（实测过）。
 */
export function normalizeA2UISpec(raw: unknown): A2UISpec | null {
  if (!isRecord(raw)) return null
  const componentsRaw = raw.components
  if (!Array.isArray(componentsRaw) || componentsRaw.length === 0) return null

  const out: A2UIComponent[] = []
  for (const comp of componentsRaw.slice(0, A2UI_LIMITS.maxComponents)) {
    const normalized = normalizeComponent(comp)
    if (!normalized) continue
    out.push({ ...normalized, id: normalized.id || `c${out.length}` })
  }
  if (out.length === 0) return null
  // 组件数被截断或过滤时下标 id 可能撞车：统一按最终下标重写，保证唯一且稳定
  return { components: out.map((c, i) => ({ ...c, id: `c${i}` })) }
}

/** 规格里是否含至少一个已知组件（用于区分普通 JSON 与 A2UI，避免误渲染） */
export function looksLikeA2UISpec(raw: unknown): boolean {
  if (!isRecord(raw)) return false
  const components = raw.components
  if (!Array.isArray(components) || components.length === 0) return false
  return components.some((c) => isRecord(c) && (c.type === 'Chart' || c.type === 'DataTable'))
}
