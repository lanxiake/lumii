/**
 * 能力雷达图组件
 *
 * 展示 Agent 在多个能力维度上的水平和置信度。
 * 使用 Canvas 绘制雷达图，支持自定义尺寸。
 */

import React from 'react'
import { useDataThemeColorMode } from '../../hooks/common/useDataThemeColorMode/useDataThemeColorMode'
import './CapabilityRadar.css'

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

/* canvas 画不了 CSS 变量，这里映射到 token 名，运行时取计算值，
   避免写死 hex 在浅色/深色主题下失真 */
const readToken = (name: string, fallback: string): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** 雷达图绘制配色 */
interface RadarColors {
  grid: string
  axis: string
  levelFill: string
  levelStroke: string
  confFill: string
  confStroke: string
  label: string
  sublabel: string
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
  /** 画布边长，默认 280（适合侧栏布局） */
  size?: number
}

/**
 * 能力雷达图组件
 */
export function CapabilityRadar({ capabilities, size = 280 }: CapabilityRadarProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const colorMode = useDataThemeColorMode()

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

    const colors: RadarColors = {
      grid: readToken('--mt-fg-3', '#94a3b8'),
      axis: readToken('--mt-fg-3', '#94a3b8'),
      levelFill: `rgba(${readToken('--mt-accent-rgb', '59, 130, 246')}, 0.28)`,
      levelStroke: `rgba(${readToken('--mt-accent-rgb', '59, 130, 246')}, 0.85)`,
      confFill: `rgba(${readToken('--mt-success-rgb', '34, 197, 94')}, 0.16)`,
      confStroke: `rgba(${readToken('--mt-success-rgb', '34, 197, 94')}, 0.8)`,
      label: readToken('--mt-fg-2', '#334155'),
      sublabel: readToken('--mt-fg-3', '#64748b'),
    }

    const dpr = globalThis.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)
    drawRadarChart(ctx, size, size, data, colors)
  }, [data, size, colorMode])

  if (data.length === 0) {
    return (
      <div className="capability-radar empty">
        <p>暂无能力数据</p>
      </div>
    )
  }

  return (
    <div className="capability-radar">
      <canvas ref={canvasRef} title="能力雷达：实心区为能力水平，虚线区为置信度" />
      <div className="radar-legend">
        <div className="legend-item" title="能力水平：该维度当前预估熟练度">
          <span className="legend-color level"></span>
          <span className="legend-label">能力水平</span>
        </div>
        <div className="legend-item" title="置信度：对水平判断的确信程度，样本少时通常更低">
          <span className="legend-color confidence"></span>
          <span className="legend-label">置信度</span>
        </div>
      </div>
    </div>
  )
}

/**
 * 绘制能力雷达网格、水平与置信度多边形
 */
function drawRadarChart(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: Array<{
    label: string
    level: number
    confidence: number
  }>,
  colors: RadarColors,
) {
  if (data.length === 0) return

  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) / 2 - 52
  const levels = 5
  const angleStep = (Math.PI * 2) / data.length

  ctx.strokeStyle = colors.grid
  ctx.globalAlpha = 0.45
  ctx.lineWidth = 1

  for (let i = 1; i <= levels; i++) {
    const r = (radius * i) / levels
    ctx.beginPath()
    for (let j = 0; j <= data.length; j++) {
      const angle = angleStep * j - Math.PI / 2
      const x = centerX + r * Math.cos(angle)
      const y = centerY + r * Math.sin(angle)
      if (j === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.stroke()
  }

  ctx.strokeStyle = colors.axis
  ctx.globalAlpha = 0.55
  for (let i = 0; i < data.length; i++) {
    const angle = angleStep * i - Math.PI / 2
    const x = centerX + radius * Math.cos(angle)
    const y = centerY + radius * Math.sin(angle)
    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.lineTo(x, y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  ctx.fillStyle = colors.levelFill
  ctx.strokeStyle = colors.levelStroke
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let i = 0; i <= data.length; i++) {
    const item = data[i % data.length]
    const angle = angleStep * i - Math.PI / 2
    const r = radius * item.level
    const x = centerX + r * Math.cos(angle)
    const y = centerY + r * Math.sin(angle)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = colors.confFill
  ctx.strokeStyle = colors.confStroke
  ctx.setLineDash([5, 5])
  ctx.beginPath()
  for (let i = 0; i <= data.length; i++) {
    const item = data[i % data.length]
    const angle = angleStep * i - Math.PI / 2
    const r = radius * item.confidence
    const x = centerX + r * Math.cos(angle)
    const y = centerY + r * Math.sin(angle)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.setLineDash([])

  ctx.font = '12px sans-serif'
  ctx.textBaseline = 'middle'

  for (let i = 0; i < data.length; i++) {
    const angle = angleStep * i - Math.PI / 2
    const labelRadius = radius + 26
    const x = centerX + labelRadius * Math.cos(angle)
    const y = centerY + labelRadius * Math.sin(angle)

    if (Math.abs(Math.cos(angle)) < 0.1) ctx.textAlign = 'center'
    else if (Math.cos(angle) > 0) ctx.textAlign = 'left'
    else ctx.textAlign = 'right'

    ctx.fillStyle = colors.label
    ctx.fillText(data[i].label, x, y)
    ctx.font = '11px sans-serif'
    ctx.fillStyle = colors.sublabel
    ctx.fillText(`${(data[i].level * 100).toFixed(0)}%`, x, y + 14)
    ctx.font = '12px sans-serif'
  }
}
