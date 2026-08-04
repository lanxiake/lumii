/**
 * TokenTrendChart - Token 使用趋势折线图
 *
 * 纯 SVG 折线图，展示每日 Token 消耗趋势
 */

import type { FC } from 'react'
import { useMemo } from 'react'
import type { CronRun } from '../../../../hooks/business/useCron/types'

interface TokenTrendChartProps {
  runs: CronRun[]
  /** 图表高度 */
  height?: number
}

interface DailyData {
  date: string
  tokens: number
  count: number
}

export const TokenTrendChart: FC<TokenTrendChartProps> = ({ runs, height = 140 }) => {
  const dailyData = useMemo(() => {
    const map = new Map<string, { tokens: number; count: number }>()

    for (const run of runs) {
      const date = new Date(run.startedAt).toLocaleDateString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
      })
      const existing = map.get(date) ?? { tokens: 0, count: 0 }
      map.set(date, {
        tokens: existing.tokens + (run.totalTokens ?? 0),
        count: existing.count + 1,
      })
    }

    // 按日期排序
    const entries: DailyData[] = Array.from(map.entries())
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date))

    return entries
  }, [runs])

  if (dailyData.length < 2) {
    return (
      <div style={emptyStyle}>
        数据不足，至少需要 2 天的运行记录才能展示趋势图
      </div>
    )
  }

  const width = 400
  const padding = { top: 16, right: 16, bottom: 24, left: 48 }
  const chartW = width - padding.left - padding.right
  const chartH = height - padding.top - padding.bottom

  const maxTokens = Math.max(...dailyData.map((d) => d.tokens), 1)
  const stepX = chartW / (dailyData.length - 1)

  // 生成折线路径
  const points = dailyData.map((d, i) => ({
    x: padding.left + i * stepX,
    y: padding.top + chartH - (d.tokens / maxTokens) * chartH,
  }))

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

  // 渐变填充区域路径
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${padding.top + chartH} L ${points[0].x} ${padding.top + chartH} Z`

  // Y 轴刻度（3 档）
  const yTicks = [0, Math.round(maxTokens / 2), maxTokens]

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>Token 趋势</div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        style={{ overflow: 'visible' }}
      >
        <defs>
          <linearGradient id="tokenGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary-500)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="var(--color-primary-500)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* 网格线 */}
        {yTicks.map((tick) => {
          const y = padding.top + chartH - (tick / maxTokens) * chartH
          return (
            <g key={tick}>
              <line
                x1={padding.left}
                y1={y}
                x2={padding.left + chartW}
                y2={y}
                stroke="var(--color-border)"
                strokeWidth="0.5"
                strokeDasharray="3,3"
              />
              <text
                x={padding.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--color-text-tertiary)"
              >
                {tick >= 1000 ? `${(tick / 1000).toFixed(0)}k` : tick}
              </text>
            </g>
          )
        })}

        {/* 填充区域 */}
        <path d={areaPath} fill="url(#tokenGradient)" />

        {/* 折线 */}
        <path d={linePath} fill="none" stroke="var(--color-primary-500)" strokeWidth="1.5" />

        {/* 数据点 */}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r="2.5"
            fill="var(--color-primary-500)"
            stroke="var(--color-bg-primary)"
            strokeWidth="1"
          />
        ))}

        {/* X 轴日期 */}
        {dailyData.map((d, i) => {
          // 太密时只显示部分标签
          const showLabel = dailyData.length <= 7 || i % Math.ceil(dailyData.length / 7) === 0
          if (!showLabel) return null
          return (
            <text
              key={i}
              x={points[i].x}
              y={padding.top + chartH + 14}
              textAnchor="middle"
              fontSize="10"
              fill="var(--color-text-tertiary)"
            >
              {d.date}
            </text>
          )
        })}
      </svg>
    </div>
  )
}

const containerStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-secondary)',
}

const headerStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--color-text-secondary)',
  marginBottom: 6,
}

const emptyStyle: React.CSSProperties = {
  padding: '20px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-secondary)',
  fontSize: 12,
  color: 'var(--color-text-tertiary)',
  textAlign: 'center',
}
