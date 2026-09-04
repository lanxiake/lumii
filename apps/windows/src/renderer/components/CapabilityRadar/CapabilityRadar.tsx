/**
 * 能力雷达图组件
 *
 * 展示 Agent 在 8 个能力维度上的水平和置信度。
 * 使用 Recharts 库绘制雷达图。
 */

import React from 'react'
import './CapabilityRadar.css'

/**
 * 能力维度数据
 */
export interface CapabilityData {
  dimension: string
  level: number
  confidence: number
}

/**
 * 能力维度中文标签
 */
const DIMENSION_LABELS: Record<string, string> = {
  code_generation: '代码生成',
  document_analysis: '文档分析',
  web_search: '网络搜索',
  data_processing: '数据处理',
  api_integration: 'API集成',
  creative_writing: '创意写作',
  logical_reasoning: '逻辑推理',
  multi_step_planning: '多步规划',
}

/**
 * 能力雷达图组件属性
 */
interface CapabilityRadarProps {
  capabilities: Record<
    string,
    {
      level: number
      confidence: number
      testCount: number
    }
  >
}

/**
 * 能力雷达图组件
 *
 * 使用 Canvas 绘制雷达图，避免依赖外部库。
 */
export function CapabilityRadar({ capabilities }: CapabilityRadarProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)

  // 转换数据格式
  const data = React.useMemo(() => {
    return Object.entries(capabilities).map(([dim, state]) => ({
      dimension: dim,
      label: DIMENSION_LABELS[dim] || dim,
      level: state.level,
      confidence: state.confidence,
      testCount: state.testCount,
    }))
  }, [capabilities])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 清空画布
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // 绘制雷达图
    drawRadarChart(ctx, canvas.width, canvas.height, data)
  }, [data])

  if (data.length === 0) {
    return (
      <div className="capability-radar empty">
        <p>暂无能力数据</p>
      </div>
    )
  }

  return (
    <div className="capability-radar">
      <canvas ref={canvasRef} width={500} height={500} />
      <div className="radar-legend">
        <div className="legend-item">
          <span className="legend-color level"></span>
          <span className="legend-label">能力水平</span>
        </div>
        <div className="legend-item">
          <span className="legend-color confidence"></span>
          <span className="legend-label">置信度</span>
        </div>
      </div>
    </div>
  )
}

/**
 * 绘制雷达图
 */
function drawRadarChart(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: Array<{
    label: string
    level: number
    confidence: number
  }>
) {
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) / 2 - 60
  const levels = 5 // 5 个级别
  const angleStep = (Math.PI * 2) / data.length

  // 绘制背景网格
  ctx.strokeStyle = '#e0e0e0'
  ctx.lineWidth = 1

  for (let i = 1; i <= levels; i++) {
    const r = (radius * i) / levels
    ctx.beginPath()

    for (let j = 0; j <= data.length; j++) {
      const angle = angleStep * j - Math.PI / 2
      const x = centerX + r * Math.cos(angle)
      const y = centerY + r * Math.sin(angle)

      if (j === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }

    ctx.closePath()
    ctx.stroke()
  }

  // 绘制轴线
  ctx.strokeStyle = '#ccc'
  for (let i = 0; i < data.length; i++) {
    const angle = angleStep * i - Math.PI / 2
    const x = centerX + radius * Math.cos(angle)
    const y = centerY + radius * Math.sin(angle)

    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.lineTo(x, y)
    ctx.stroke()
  }

  // 绘制能力水平（蓝色填充）
  ctx.fillStyle = 'rgba(24, 144, 255, 0.3)'
  ctx.strokeStyle = 'rgba(24, 144, 255, 0.8)'
  ctx.lineWidth = 2
  ctx.beginPath()

  for (let i = 0; i <= data.length; i++) {
    const item = data[i % data.length]
    const angle = angleStep * i - Math.PI / 2
    const r = radius * item.level
    const x = centerX + r * Math.cos(angle)
    const y = centerY + r * Math.sin(angle)

    if (i === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  }

  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // 绘制置信度（绿色虚线）
  ctx.fillStyle = 'rgba(130, 202, 157, 0.2)'
  ctx.strokeStyle = 'rgba(130, 202, 157, 0.8)'
  ctx.setLineDash([5, 5])
  ctx.beginPath()

  for (let i = 0; i <= data.length; i++) {
    const item = data[i % data.length]
    const angle = angleStep * i - Math.PI / 2
    const r = radius * item.confidence
    const x = centerX + r * Math.cos(angle)
    const y = centerY + r * Math.sin(angle)

    if (i === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  }

  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.setLineDash([])

  // 绘制维度标签
  ctx.fillStyle = '#333'
  ctx.font = '14px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (let i = 0; i < data.length; i++) {
    const angle = angleStep * i - Math.PI / 2
    const labelRadius = radius + 30
    const x = centerX + labelRadius * Math.cos(angle)
    const y = centerY + labelRadius * Math.sin(angle)

    // 调整文本对齐
    if (Math.abs(Math.cos(angle)) < 0.1) {
      ctx.textAlign = 'center'
    } else if (Math.cos(angle) > 0) {
      ctx.textAlign = 'left'
    } else {
      ctx.textAlign = 'right'
    }

    ctx.fillText(data[i].label, x, y)

    // 绘制数值
    ctx.font = '12px sans-serif'
    ctx.fillStyle = '#666'
    ctx.fillText(`${(data[i].level * 100).toFixed(0)}%`, x, y + 16)
    ctx.font = '14px sans-serif'
    ctx.fillStyle = '#333'
  }
}
