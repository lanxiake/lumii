/**
 * A2UI Chart 组件 — 使用 recharts 渲染数据图表
 */

import React from 'react'
import {
  ResponsiveContainer,
  LineChart, Line,
  BarChart, Bar,
  PieChart, Pie, Cell,
  AreaChart, Area,
  ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import type { A2UIChart } from './types'
import styles from './A2UIRenderer.module.css'

const COLORS = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b',
]

/** 将 A2UI data 格式转为 recharts 数据格式 */
function toRechartsData(data: A2UIChart['data']): Record<string, unknown>[] {
  if (!data?.labels?.length) return []
  return data.labels.map((label, i) => {
    const point: Record<string, unknown> = { name: label }
    for (const ds of (data.datasets ?? [])) {
      point[ds.label] = ds.values?.[i] ?? 0
    }
    return point
  })
}

export const ChartComponent: React.FC<A2UIChart> = ({ chartType, title, data }) => {
  if (!data?.labels || !data?.datasets) {
    return <div className={styles['a2ui-fallback']}>图表数据格式错误</div>
  }
  const chartData = toRechartsData(data)
  const datasetLabels = data.datasets.map((ds) => ds.label)

  const renderChart = () => {
    switch (chartType) {
      case 'line':
        return (
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            {datasetLabels.map((label, i) => (
              <Line key={label} type="monotone" dataKey={label} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={{ r: 3 }} />
            ))}
          </LineChart>
        )
      case 'bar':
        return (
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            {datasetLabels.map((label, i) => (
              <Bar key={label} dataKey={label} fill={COLORS[i % COLORS.length]} />
            ))}
          </BarChart>
        )
      case 'area':
        return (
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            {datasetLabels.map((label, i) => (
              <Area key={label} type="monotone" dataKey={label} fill={COLORS[i % COLORS.length]} fillOpacity={0.3} stroke={COLORS[i % COLORS.length]} />
            ))}
          </AreaChart>
        )
      case 'scatter':
        return (
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            {datasetLabels.map((label, i) => (
              <Scatter key={label} name={label} data={chartData} fill={COLORS[i % COLORS.length]} />
            ))}
          </ScatterChart>
        )
      case 'pie': {
        const pieData = data.labels.map((label, i) => ({
          name: label,
          value: data.datasets[0]?.values[i] ?? 0,
        }))
        return (
          <PieChart>
            <Tooltip />
            <Legend />
            <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
              {pieData.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        )
      }
      default:
        return <div>不支持的图表类型: {chartType}</div>
    }
  }

  return (
    <div className={styles['a2ui-chart']}>
      {title && <div className={styles['a2ui-chart-title']}>{title}</div>}
      <ResponsiveContainer width="100%" height={250}>
        {renderChart()}
      </ResponsiveContainer>
    </div>
  )
}
