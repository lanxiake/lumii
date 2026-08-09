/**
 * UsageChart - 用量趋势折线图
 *
 * 三条折线：输入 / 输出 Token（左轴）、花费（元，右轴）。
 * 悬停 Tooltip 展示该时间桶的完整明细（含请求次数）。
 */

import React, { useMemo } from 'react'
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import type { UsageBucketView } from '../../../../hooks/business/useDashboard'
import { centsToCny, formatCostCny } from '../../../../../shared/model-pricing'
import styles from './UsageChart.module.css'

export interface UsageChartProps {
  buckets: readonly UsageBucketView[]
  groupBy: 'hour' | 'day'
}

const COLOR = {
  input: '#3b82f6',
  output: '#8b5cf6',
  calls: '#06b6d4',
  cost: '#22c55e',
} as const

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
  输入: number
  输出: number
  请求: number
  /** 人民币元，供折线与 Tooltip */
  花费: number
  costCents: number
  unpricedCalls: number
}

interface TipPayloadItem {
  dataKey?: string | number
  value?: number
  color?: string
  payload?: ChartRow
}

/**
 * 自定义悬停卡片：中文标签 + 元单位
 */
function UsageTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: TipPayloadItem[]
  label?: string
}): React.ReactElement | null {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  if (!row) return null

  return (
    <div className={styles.tip}>
      <div className={styles['tip-title']}>{label}</div>
      <div className={styles['tip-row']}>
        <i style={{ background: COLOR.input }} />
        <span>输入 Token</span>
        <b>{fmtTok(row.输入)}</b>
      </div>
      <div className={styles['tip-row']}>
        <i style={{ background: COLOR.output }} />
        <span>输出 Token</span>
        <b>{fmtTok(row.输出)}</b>
      </div>
      <div className={styles['tip-row']}>
        <i style={{ background: COLOR.calls }} />
        <span>请求次数</span>
        <b>{row.请求}</b>
      </div>
      <div className={styles['tip-row']}>
        <i style={{ background: COLOR.cost }} />
        <span>花费</span>
        <b>
          {row.unpricedCalls > 0 && row.costCents === 0
            ? '—'
            : formatCostCny(row.costCents)}
        </b>
      </div>
      {row.unpricedCalls > 0 ? (
        <div className={styles['tip-note']}>其中 {row.unpricedCalls} 次未计价</div>
      ) : null}
    </div>
  )
}

export const UsageChart: React.FC<UsageChartProps> = ({ buckets, groupBy }) => {
  const data = useMemo<ChartRow[]>(
    () =>
      buckets.map((b) => ({
        label: labelOf(b.ts, groupBy),
        输入: b.promptTokens,
        输出: b.completionTokens,
        请求: b.calls,
        花费: Math.round(centsToCny(b.costCents) * 10_000) / 10_000,
        costCents: b.costCents,
        unpricedCalls: b.unpricedCalls,
      })),
    [buckets, groupBy],
  )

  if (buckets.length === 0) {
    return <div className={styles.empty}>该区间还没有调用记录</div>
  }

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
          <Tooltip content={<UsageTooltip />} cursor={{ fill: 'color-mix(in srgb, var(--mt-accent-500) 6%, transparent)' }} />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
            iconType="circle"
            iconSize={8}
          />
          <Line
            yAxisId="tok"
            type="monotone"
            dataKey="输入"
            name="输入 Token"
            stroke={COLOR.input}
            strokeWidth={2}
            dot={{ r: 2.5, fill: COLOR.input }}
            activeDot={{ r: 4 }}
          />
          <Line
            yAxisId="tok"
            type="monotone"
            dataKey="输出"
            name="输出 Token"
            stroke={COLOR.output}
            strokeWidth={2}
            dot={{ r: 2.5, fill: COLOR.output }}
            activeDot={{ r: 4 }}
          />
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
