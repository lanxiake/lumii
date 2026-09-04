/**
 * 满意度趋势图组件
 *
 * 展示满意度评分的历史趋势（7 天、30 天等）。
 * 使用 Canvas 绘制折线图。
 */

import React from 'react'
import './SatisfactionChart.css'

/**
 * 数据点
 */
export interface SatisfactionDataPoint {
  timestamp: string
  score: number
  windowType: 'short' | 'medium' | 'long'
}

/**
 * 满意度趋势图属性
 */
interface SatisfactionChartProps {
  history: SatisfactionDataPoint[]
  window?: '7d' | '30d' | 'all'
}

/**
 * 满意度趋势图组件
 */
export function SatisfactionChart({ history, window = '7d' }: SatisfactionChartProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const [hoveredPoint, setHoveredPoint] = React.useState<number | null>(null)

  // 过滤和排序数据
  const filteredData = React.useMemo(() => {
    const now = Date.now()
    const windowMs =
      window === '7d' ? 7 * 24 * 3600_000 : window === '30d' ? 30 * 24 * 3600_000 : Infinity

    return history
      .filter((point) => {
        const timestamp = new Date(point.timestamp).getTime()
        return now - timestamp <= windowMs
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  }, [history, window])

  // 绘制图表
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || filteredData.length === 0) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    drawChart(ctx, canvas.width, canvas.height, filteredData)
  }, [filteredData])

  if (filteredData.length === 0) {
    return (
      <div className="satisfaction-chart empty">
        <p>暂无满意度历史数据</p>
      </div>
    )
  }

  return (
    <div className="satisfaction-chart">
      <canvas
        ref={canvasRef}
        width={800}
        height={300}
        onMouseMove={(e) => handleMouseMove(e, filteredData)}
        onMouseLeave={() => setHoveredPoint(null)}
      />
      {hoveredPoint !== null && (
        <div className="chart-tooltip" style={getTooltipPosition(hoveredPoint, filteredData.length)}>
          <div className="tooltip-date">{formatDate(filteredData[hoveredPoint].timestamp)}</div>
          <div className="tooltip-score">
            满意度: {(filteredData[hoveredPoint].score * 100).toFixed(1)}%
          </div>
        </div>
      )}
    </div>
  )

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>, data: SatisfactionDataPoint[]) {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const padding = 60
    const chartWidth = canvas.width - padding * 2
    const pointSpacing = chartWidth / (data.length - 1)

    const index = Math.round((x - padding) / pointSpacing)
    if (index >= 0 && index < data.length) {
      setHoveredPoint(index)
    } else {
      setHoveredPoint(null)
    }
  }

  function getTooltipPosition(index: number, total: number): React.CSSProperties {
    const percent = (index / (total - 1)) * 100
    return {
      left: `${percent}%`,
      transform: 'translateX(-50%)',
    }
  }

  function formatDate(timestamp: string): string {
    const date = new Date(timestamp)
    return date.toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
}

/**
 * 绘制图表
 */
function drawChart(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: SatisfactionDataPoint[]
) {
  const padding = 60
  const chartWidth = width - padding * 2
  const chartHeight = height - padding * 2

  // 清空画布
  ctx.clearRect(0, 0, width, height)

  // 绘制背景网格
  ctx.strokeStyle = '#f0f0f0'
  ctx.lineWidth = 1

  // 水平网格线（满意度等级）
  for (let i = 0; i <= 10; i++) {
    const y = padding + (chartHeight * (10 - i)) / 10
    ctx.beginPath()
    ctx.moveTo(padding, y)
    ctx.lineTo(width - padding, y)
    ctx.stroke()

    // Y 轴标签
    ctx.fillStyle = '#999'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${i * 10}%`, padding - 10, y)
  }

  // 绘制数据线
  if (data.length > 0) {
    ctx.strokeStyle = '#1890ff'
    ctx.lineWidth = 3
    ctx.beginPath()

    const pointSpacing = chartWidth / (data.length - 1)

    data.forEach((point, index) => {
      const x = padding + index * pointSpacing
      const y = padding + chartHeight * (1 - point.score)

      if (index === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    })

    ctx.stroke()

    // 绘制数据点
    ctx.fillStyle = '#1890ff'
    data.forEach((point, index) => {
      const x = padding + index * pointSpacing
      const y = padding + chartHeight * (1 - point.score)

      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fill()
    })

    // 绘制面积填充
    ctx.fillStyle = 'rgba(24, 144, 255, 0.1)'
    ctx.beginPath()
    ctx.moveTo(padding, padding + chartHeight)

    data.forEach((point, index) => {
      const x = padding + index * pointSpacing
      const y = padding + chartHeight * (1 - point.score)
      ctx.lineTo(x, y)
    })

    ctx.lineTo(padding + chartWidth, padding + chartHeight)
    ctx.closePath()
    ctx.fill()
  }

  // 绘制 X 轴标签（日期）
  ctx.fillStyle = '#999'
  ctx.font = '12px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'

  const labelCount = Math.min(6, data.length)
  const labelSpacing = Math.floor(data.length / labelCount)

  for (let i = 0; i < data.length; i += labelSpacing) {
    const point = data[i]
    const x = padding + i * (chartWidth / (data.length - 1))
    const date = new Date(point.timestamp)
    const label = date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    ctx.fillText(label, x, height - padding + 10)
  }

  // 绘制边框
  ctx.strokeStyle = '#d9d9d9'
  ctx.lineWidth = 1
  ctx.strokeRect(padding, padding, chartWidth, chartHeight)
}
