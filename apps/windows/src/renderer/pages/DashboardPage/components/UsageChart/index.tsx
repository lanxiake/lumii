/**
 * UsageChart - 用量趋势柱状图
 *
 * Token 按模型细分（堆叠柱，左轴）、花费（虚线，右轴）。
 * 每个模型占两个堆叠段（输入/输出），颜色按模型循环分配。
 * 悬停 Tooltip 展示该时间桶的完整明细（含请求次数与按模型 Token）。
 */

import React, { useMemo } from 'react'
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import type { UsageBucketView } from '../../../../hooks/business/useDashboard'
import { formatCostYuan } from '../../../../../shared/model-pricing'
import styles from './UsageChart.module.css'

export interface UsageChartProps {
  buckets: readonly UsageBucketView[]
  groupBy: 'hour' | 'day'
}

const COLOR = {
  calls: '#06b6d4',
  cost: '#22c55e',
} as const

/** 模型分色调色板；输入取偶数槽、输出取奇数槽，模型多时循环 */
const PALETTE = [
  '#3b82f6', '#93c5fd',
  '#8b5cf6', '#c4b5fd',
  '#22c55e', '#86efac',
  '#f59e0b', '#fcd34d',
  '#ef4444', '#fca5a5',
  '#06b6d4', '#67e8f9',
  '#ec4899', '#f9a8d4',
  '#f97316', '#fdba74',
] as const

const IN_KEY = (m: string): string => `${m}::in`
const OUT_KEY = (m: string): string => `${m}::out`

/** X 轴时间标签 */
function labelOf(ts: number, groupBy: 'hour' | 'day'): string {
  const d = new Date(ts)
  return groupBy === 'hour'
    ? `${String(d.getHours()).padStart(2, '0')}:00`
    : `${d.getMonth() + 1}/${d.getDate()}`
}

/** Token 紧凑展示 */
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

interface ChartRow {
  label: string
  请求: number
  /** 人民币元，供折线 */
  花费: number
  costYuan: number
  unpricedCalls: number
  /** 全部模型的花费明细（含本桶无调用的模型，花费记 0），供 Tooltip 展示 */
  byModel: Array<{ model: string; costYuan: number }>
  /** 动态键：`${model}::in` / `${model}::out` */
  [modelKey: string]: number | string | Array<{ model: string; costYuan: number }>
}

interface TipPayloadItem {
  dataKey?: string | number
  value?: number
  color?: string
  payload?: ChartRow
}

/**
 * 自定义悬停卡片：总计 + 按模型花费明细（降序，含 0 花费模型）
 */
function UsageTooltip({
  active,
  payload,
  label,
  colorForModel,
}: {
  active?: boolean
  payload?: TipPayloadItem[]
  label?: string
  colorForModel: Map<string, string>
}): React.ReactElement | null {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  if (!row) return null

  return (
    <div className={styles.tip}>
      <div className={styles['tip-title']}>{label}</div>
      <div className={styles['tip-row']}>
        <i style={{ background: COLOR.cost }} />
        <span>总计</span>
        <b>{formatCostYuan(row.costYuan)}</b>
      </div>
      {row.byModel.map((m) => (
        <div className={styles['tip-row']} key={m.model}>
          <i style={{ background: colorForModel.get(m.model) ?? '#888' }} />
          <span>{m.model}</span>
          <b>{formatCostYuan(m.costYuan)}</b>
        </div>
      ))}
      {row.unpricedCalls > 0 ? (
        <div className={styles['tip-note']}>其中 {row.unpricedCalls} 次未计价</div>
      ) : null}
    </div>
  )
}

/** 图例只显示模型（一项一模型），输入段颜色代表该模型 */
function ModelLegend(props: { payload?: Array<{ dataKey?: string | number; color?: string }> }): React.ReactElement | null {
  const items = (props.payload ?? [])
    .map((p) => {
      const key = String(p.dataKey ?? '')
      const sep = key.indexOf('::')
      return { model: sep < 0 ? key : key.slice(0, sep), color: p.color ?? '#888' }
    })
    .filter((x) => x.model)
  // 相邻同模型项去重（每模型有 in/out 两条）
  const seen = new Set<string>()
  const unique = items.filter((x) => {
    if (seen.has(x.model)) return false
    seen.add(x.model)
    return true
  })
  if (unique.length === 0) return null
  return (
    <div className={styles['model-legend']}>
      {unique.map((x) => (
        <span key={x.model} className={styles['model-legend-item']}>
          <i style={{ background: x.color }} />
          {x.model}
        </span>
      ))}
    </div>
  )
}

export const UsageChart: React.FC<UsageChartProps> = ({ buckets, groupBy }) => {
  /** 全部桶中出现的模型并集，按合计花费降序（颜色分配稳定） */
  const models = useMemo(() => {
    const cost = new Map<string, number>()
    for (const b of buckets) {
      for (const m of b.byModel) {
        cost.set(m.model, (cost.get(m.model) ?? 0) + m.costYuan)
      }
    }
    return [...cost.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
  }, [buckets])

  const data = useMemo<ChartRow[]>(
    () =>
      buckets.map((b) => {
        const row: ChartRow = {
          label: labelOf(b.ts, groupBy),
          请求: b.calls,
          花费: Math.round(b.costYuan * 10_000) / 10_000,
          costYuan: b.costYuan,
          unpricedCalls: b.unpricedCalls,
          byModel: models
            .map((m) => ({ model: m, costYuan: b.byModel.find((x) => x.model === m)?.costYuan ?? 0 }))
            .sort((a, b2) => b2.costYuan - a.costYuan),
        }
        for (const m of models) {
          const s = b.byModel.find((x) => x.model === m)
          row[IN_KEY(m)] = s?.promptTokens ?? 0
          row[OUT_KEY(m)] = s?.completionTokens ?? 0
        }
        return row
      }),
    [buckets, models, groupBy],
  )

  if (buckets.length === 0) {
    return <div className={styles.empty}>该区间还没有调用记录</div>
  }

  const colorForModel = new Map(models.map((m, i) => [m, PALETTE[(i * 2) % PALETTE.length]!]))

  const bars = models.flatMap((m, i) => {
    const inFill = PALETTE[(i * 2) % PALETTE.length]
    const outFill = PALETTE[(i * 2 + 1) % PALETTE.length]
    const isTop = i === models.length - 1
    return [
      <Bar
        key={IN_KEY(m)}
        yAxisId="tok"
        dataKey={IN_KEY(m)}
        name={`${m} 输入`}
        stackId="tok"
        fill={inFill}
        radius={[0, 0, 0, 0]}
      />,
      <Bar
        key={OUT_KEY(m)}
        yAxisId="tok"
        dataKey={OUT_KEY(m)}
        name={`${m} 输出`}
        stackId="tok"
        fill={outFill}
        radius={isTop ? [2, 2, 0, 0] : [0, 0, 0, 0]}
      />,
    ]
  })

  return (
    <div className={styles.wrap}>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--mt-border-hairline)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: 'var(--mt-fg-4)' }}
            axisLine={{ stroke: 'var(--mt-border)' }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="tok"
            tick={{ fontSize: 10, fill: 'var(--mt-fg-4)' }}
            axisLine={false}
            tickLine={false}
            width={40}
            tickFormatter={(v: number) => fmtTok(v)}
          />
          <YAxis
            yAxisId="meta"
            orientation="right"
            tick={{ fontSize: 10, fill: 'var(--mt-fg-4)' }}
            axisLine={false}
            tickLine={false}
            width={44}
            tickFormatter={(v: number) => (v >= 1 ? `${v.toFixed(1)}` : `${v.toFixed(3)}`)}
          />
          <Tooltip content={<UsageTooltip colorForModel={colorForModel} />} cursor={{ fill: 'color-mix(in srgb, var(--mt-accent-500) 6%, transparent)' }} />
          <Legend content={<ModelLegend />} />
          {bars}
          <Line
            yAxisId="meta"
            type="monotone"
            dataKey="花费"
            name="花费（元）"
            stroke={COLOR.cost}
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={{ r: 2.5, fill: COLOR.cost }}
            activeDot={{ r: 4 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

export default UsageChart
