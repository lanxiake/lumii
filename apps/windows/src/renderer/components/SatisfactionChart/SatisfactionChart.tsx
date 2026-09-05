/**
 * 满意度趋势图组件
 *
 * 展示满意度评分的历史趋势（7 天、30 天等）。
 * 使用 Canvas 绘制折线图，支持容器自适应尺寸。
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
  /** 填满父容器高度（概览布局用） */
  fillHeight?: boolean
}

/** 绘图边距：为轴标签预留足够空间，避免被裁切 */
const CHART_PAD = {
  top: 16,
  right: 16,
  bottom: 36,
  left: 44,
} as const

/**
 * 满意度趋势图组件
 */
export function SatisfactionChart({ history, window = '7d', fillHeight = false }: SatisfactionChartProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [hoveredPoint, setHoveredPoint] = React.useState<number | null>(null)
  const [size, setSize] = React.useState({ width: 640, height: 240 })

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

  // 监听容器尺寸
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return

    /** 根据容器更新画布逻辑尺寸 */
    const updateSize = () => {
      const rect = el.getBoundingClientRect()
      const width = Math.max(260, Math.floor(rect.width))
      const height = fillHeight
        ? Math.max(200, Math.floor(rect.height || 240))
        : Math.max(200, Math.min(280, Math.floor(rect.width * 0.42)))
      setSize({ width, height })
    }

    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(el)
    return () => observer.disconnect()
  }, [fillHeight])

  // 绘制图表
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || filteredData.length === 0) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = globalThis.devicePixelRatio || 1
    canvas.width = size.width * dpr
    canvas.height = size.height * dpr
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    drawChart(ctx, size.width, size.height, filteredData)
  }, [filteredData, size])

  if (filteredData.length === 0) {
    return (
      <div className={`satisfaction-chart empty${fillHeight ? ' fill' : ''}`} ref={containerRef}>
        <p>暂无满意度历史数据</p>
      </div>
    )
  }

  return (
    <div className={`satisfaction-chart${fillHeight ? ' fill' : ''}`} ref={containerRef}>
      <canvas
        ref={canvasRef}
        onMouseMove={(e) => handleMouseMove(e, filteredData, size.width)}
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

  /** 根据鼠标位置定位最近数据点 */
  function handleMouseMove(
    e: React.MouseEvent<HTMLCanvasElement>,
    data: SatisfactionDataPoint[],
    chartWidth: number,
  ) {
    const canvas = canvasRef.current
    if (!canvas || data.length === 0) return

    const rect = canvas.getBoundingClientRect()
    const scaleX = chartWidth / Math.max(rect.width, 1)
    const x = (e.clientX - rect.left) * scaleX
    const plotWidth = chartWidth - CHART_PAD.left - CHART_PAD.right
    if (data.length === 1) {
      setHoveredPoint(0)
      return
    }
    const pointSpacing = plotWidth / (data.length - 1)
    const index = Math.round((x - CHART_PAD.left) / pointSpacing)
    if (index >= 0 && index < data.length) {
      setHoveredPoint(index)
    } else {
      setHoveredPoint(null)
    }
  }

  /** 计算 tooltip 水平位置（相对绘图区） */
  function getTooltipPosition(index: number, total: number): React.CSSProperties {
    const plotStart = CHART_PAD.left / Math.max(size.width, 1)
    const plotWidth = (size.width - CHART_PAD.left - CHART_PAD.right) / Math.max(size.width, 1)
    const t = total <= 1 ? 0.5 : index / (total - 1)
    const percent = (plotStart + plotWidth * t) * 100
    return {
      left: `${percent}%`,
      transform: 'translateX(-50%)',
    }
  }

  /** 格式化悬停时间 */
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
 * 绘制满意度折线、面积与坐标轴标签
 */
function drawChart(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: SatisfactionDataPoint[],
) {
  const { top, right, bottom, left } = CHART_PAD
  const chartWidth = Math.max(1, width - left - right)
  const chartHeight = Math.max(1, height - top - bottom)

  ctx.clearRect(0, 0, width, height)

  // Y 轴网格与标签
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)'
  ctx.lineWidth = 1
  ctx.font = '11px system-ui, "Segoe UI", sans-serif'

  for (let i = 0; i <= 5; i++) {
    const y = top + (chartHeight * (5 - i)) / 5
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(width - right, y)
    ctx.stroke()

    ctx.fillStyle = '#94a3b8'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${i * 20}%`, left - 6, y)
  }

  if (data.length === 0) return

  const pointSpacing = data.length === 1 ? 0 : chartWidth / (data.length - 1)

  /** 数据点屏幕坐标 */
  const pointAt = (index: number) => {
    const x = left + (data.length === 1 ? chartWidth / 2 : index * pointSpacing)
    const y = top + chartHeight * (1 - data[index].score)
    return { x, y }
  }

  // 折线
  ctx.strokeStyle = '#3b82f6'
  ctx.lineWidth = 2.5
  ctx.beginPath()
  data.forEach((_, index) => {
    const { x, y } = pointAt(index)
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()

  // 面积
  ctx.fillStyle = 'rgba(59, 130, 246, 0.12)'
  ctx.beginPath()
  const first = pointAt(0)
  ctx.moveTo(first.x, top + chartHeight)
  data.forEach((_, index) => {
    const { x, y } = pointAt(index)
    ctx.lineTo(x, y)
  })
  const last = pointAt(data.length - 1)
  ctx.lineTo(last.x, top + chartHeight)
  ctx.closePath()
  ctx.fill()

  // 数据点
  ctx.fillStyle = '#3b82f6'
  data.forEach((_, index) => {
    const { x, y } = pointAt(index)
    ctx.beginPath()
    ctx.arc(x, y, 3.5, 0, Math.PI * 2)
    ctx.fill()
  })

  // X 轴日期标签（短格式，避免溢出）
  ctx.fillStyle = '#94a3b8'
  ctx.font = '11px system-ui, "Segoe UI", sans-serif'
  ctx.textBaseline = 'top'

  const labelCount = Math.min(5, data.length)
  const labelStep = Math.max(1, Math.floor((data.length - 1) / Math.max(1, labelCount - 1)))
  const labelYs = top + chartHeight + 10

  for (let i = 0; i < data.length; i += labelStep) {
    const { x } = pointAt(i)
    const date = new Date(data[i].timestamp)
    const label = `${date.getMonth() + 1}/${date.getDate()}`

    if (i === 0) ctx.textAlign = 'left'
    else if (i >= data.length - 1 || i + labelStep >= data.length) ctx.textAlign = 'right'
    else ctx.textAlign = 'center'

    ctx.fillText(label, x, labelYs)
  }

  // 确保包含最后一个点的标签
  const lastIndex = data.length - 1
  if (lastIndex > 0 && lastIndex % labelStep !== 0) {
    const { x } = pointAt(lastIndex)
    const date = new Date(data[lastIndex].timestamp)
    ctx.textAlign = 'right'
    ctx.fillText(`${date.getMonth() + 1}/${date.getDate()}`, x, labelYs)
  }
}
