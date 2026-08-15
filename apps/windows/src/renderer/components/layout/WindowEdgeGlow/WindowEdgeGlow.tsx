/**
 * WindowEdgeGlow - 窗口边缘手电筒式感应光效
 *
 * 鼠标靠近任意边时：光斑以指针处最亮最大，向两侧与内侧衰减；
 * 边线呈现波浪形，振幅随靠近程度增强。
 *
 * 顶边特殊处理：标题栏 `-webkit-app-region: drag` 会吞掉 DOM mousemove，
 * 因此优先通过主进程 screen API 读取光标位置；画布置于标题栏之上绘制。
 */

import React, { useEffect, useRef } from 'react'
import styles from './WindowEdgeGlow.module.css'

type Edge = 'top' | 'right' | 'bottom' | 'left'

/** 默认标题栏高度（与 --mt-titlebar-h 对齐） */
const DEFAULT_TITLEBAR_H = 36

/**
 * 各边感应带宽。
 * 顶边覆盖整个标题栏（窗口顶层铬），但不延伸到聊天内容区。
 */
function buildEdgeZones(titlebarH: number): Record<Edge, number> {
  return {
    top: titlebarH,
    right: 56,
    bottom: 56,
    left: 56,
  }
}

/** 波浪影响沿边长度的半宽 */
const WAVE_HALF_SPAN = 140
/** 波浪最大振幅 */
const WAVE_AMP = 5.5
/** 光斑沿边扩散半宽 */
const GLOW_HALF_SPAN = 220
/** 光斑向内照射深度 */
const GLOW_INWARD = 80

interface EdgeHit {
  edge: Edge
  /** 0=贴边，1=感应区外缘 */
  t: number
  x: number
  y: number
  w: number
  h: number
}

/**
 * 读取 CSS 标题栏高度
 */
function readTitlebarHeight(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--mt-titlebar-h')
    .trim()
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TITLEBAR_H
}

/**
 * 计算鼠标最近边及归一化深度（各边独立带宽）
 */
function resolveEdge(
  x: number,
  y: number,
  w: number,
  h: number,
  zones: Record<Edge, number>,
): EdgeHit | null {
  const candidates: Array<{ edge: Edge; d: number }> = [
    { edge: 'top', d: y },
    { edge: 'right', d: w - 1 - x },
    { edge: 'bottom', d: h - 1 - y },
    { edge: 'left', d: x },
  ]

  let best: EdgeHit | null = null
  for (const { edge, d } of candidates) {
    const zone = zones[edge]
    if (d < 0 || d > zone) continue
    const t = d / zone
    if (!best || t < best.t) {
      best = { edge, t, x, y, w, h }
    }
  }
  return best
}

/**
 * 读取主题强调色（带兜底）
 */
function readAccent(): { light: string; mid: string } {
  const style = getComputedStyle(document.documentElement)
  return {
    light: style.getPropertyValue('--mt-accent-400').trim() || '#60a5fa',
    mid: style.getPropertyValue('--mt-accent-500').trim() || '#3b82f6',
  }
}

/**
 * 在指定边上绘制波浪折线（高斯包络，指针处振幅最大）
 */
function drawWave(
  ctx: CanvasRenderingContext2D,
  hit: EdgeHit,
  intensity: number,
  phase: number,
  accent: { light: string; mid: string },
) {
  const { edge, x, y, w, h } = hit
  const amp = WAVE_AMP * intensity
  if (amp < 0.15) return

  const along = edge === 'top' || edge === 'bottom' ? x : y
  const len = edge === 'top' || edge === 'bottom' ? w : h
  const start = Math.max(0, along - WAVE_HALF_SPAN)
  const end = Math.min(len, along + WAVE_HALF_SPAN)
  const step = 2.5

  ctx.beginPath()
  let first = true
  for (let p = start; p <= end; p += step) {
    const dist = Math.abs(p - along) / WAVE_HALF_SPAN
    const envelope = Math.exp(-dist * dist * 2.6)
    const wave = Math.sin(p * 0.09 + phase) * amp * envelope
    let px = 0
    let py = 0
    if (edge === 'top') {
      px = p
      py = 1.2 + Math.abs(wave)
    } else if (edge === 'bottom') {
      px = p
      py = h - 1.2 - Math.abs(wave)
    } else if (edge === 'left') {
      px = 1.2 + Math.abs(wave)
      py = p
    } else {
      px = w - 1.2 - Math.abs(wave)
      py = p
    }
    if (first) {
      ctx.moveTo(px, py)
      first = false
    } else {
      ctx.lineTo(px, py)
    }
  }

  ctx.strokeStyle = accent.light
  ctx.globalAlpha = 0.28 + intensity * 0.62
  ctx.lineWidth = 1.4 + intensity * 1.4
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.shadowColor = accent.mid
  ctx.shadowBlur = 10 + intensity * 16
  ctx.stroke()
  ctx.shadowBlur = 0
  ctx.globalAlpha = 1
}

/**
 * 手电筒光斑：指针贴边投影处最亮，沿边与向内衰减
 */
function drawFlashlight(ctx: CanvasRenderingContext2D, hit: EdgeHit, intensity: number) {
  const { edge, x, y, w, h } = hit
  let cx = x
  let cy = y
  if (edge === 'top') cy = 0
  if (edge === 'bottom') cy = h
  if (edge === 'left') cx = 0
  if (edge === 'right') cx = w

  const horizontal = edge === 'top' || edge === 'bottom'

  ctx.save()
  ctx.translate(cx, cy)
  if (horizontal) {
    ctx.scale(1, GLOW_INWARD / GLOW_HALF_SPAN)
  } else {
    ctx.scale(GLOW_INWARD / GLOW_HALF_SPAN, 1)
  }

  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, GLOW_HALF_SPAN)
  grad.addColorStop(0, `rgba(147, 197, 253, ${0.55 * intensity})`)
  grad.addColorStop(0.22, `rgba(96, 165, 250, ${0.32 * intensity})`)
  grad.addColorStop(0.5, `rgba(59, 130, 246, ${0.12 * intensity})`)
  grad.addColorStop(0.78, `rgba(37, 99, 235, ${0.04 * intensity})`)
  grad.addColorStop(1, 'rgba(37, 99, 235, 0)')

  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(0, 0, GLOW_HALF_SPAN, 0, Math.PI * 2)
  ctx.fill()

  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, GLOW_HALF_SPAN * 0.28)
  core.addColorStop(0, `rgba(224, 242, 254, ${0.5 * intensity})`)
  core.addColorStop(0.45, `rgba(125, 211, 252, ${0.2 * intensity})`)
  core.addColorStop(1, 'rgba(125, 211, 252, 0)')
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(0, 0, GLOW_HALF_SPAN * 0.28, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

interface WindowEdgeGlowProps {
  /** 最大化时关闭特效 */
  disabled?: boolean
}

/**
 * 窗口边缘光效层（pointer-events: none，不挡拖拽与点击）
 */
export const WindowEdgeGlow: React.FC<WindowEdgeGlowProps> = ({ disabled = false }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hitRef = useRef<EdgeHit | null>(null)
  const rafRef = useRef(0)
  const phaseRef = useRef(0)
  const pollInFlight = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || disabled) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let accent = readAccent()
    let zones = buildEdgeZones(readTitlebarHeight())
    let alive = true

    /**
     * 同步画布尺寸与 DPR
     */
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = window.innerWidth
      const h = window.innerHeight
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      accent = readAccent()
      zones = buildEdgeZones(readTitlebarHeight())
    }

    /**
     * 根据客户端坐标更新命中并绘制
     */
    const applyPos = (x: number, y: number, inside: boolean) => {
      const w = window.innerWidth
      const h = window.innerHeight
      hitRef.current = inside ? resolveEdge(x, y, w, h, zones) : null
    }

    /**
     * 绘制一帧
     */
    const paint = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      ctx.clearRect(0, 0, w, h)
      const hit = hitRef.current
      if (!hit) return

      const intensity = Math.max(0, 1 - hit.t)
      const boost = intensity * intensity * 0.4 + intensity * 0.6
      drawFlashlight(ctx, hit, boost)
      drawWave(ctx, hit, boost, phaseRef.current, accent)
    }

    /**
     * 从主进程拉取光标（可穿透标题栏 drag 区）
     */
    const pollCursor = () => {
      const api = window.electronAPI?.window
      if (!api || typeof api.getCursorClientPos !== 'function') return
      if (pollInFlight.current) return
      pollInFlight.current = true
      void api.getCursorClientPos()
        .then((pos) => {
          if (!alive || !pos) return
          applyPos(pos.x, pos.y, pos.inside)
        })
        .catch(() => { /* ignore */ })
        .finally(() => {
          pollInFlight.current = false
        })
    }

    /**
     * DOM mousemove 兜底（非 drag 区域 / 无 Electron API 时）
     */
    const onMove = (e: MouseEvent) => {
      applyPos(e.clientX, e.clientY, true)
    }

    const onLeave = () => {
      hitRef.current = null
      paint()
    }

    /**
     * 动画循环
     */
    const tick = () => {
      pollCursor()
      if (!reduceMotion && hitRef.current) {
        phaseRef.current += 0.085
      }
      paint()
      rafRef.current = window.requestAnimationFrame(tick)
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMove, { passive: true })
    document.documentElement.addEventListener('mouseleave', onLeave)
    rafRef.current = window.requestAnimationFrame(tick)

    return () => {
      alive = false
      window.cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
    }
  }, [disabled])

  if (disabled) return null

  return (
    <canvas
      ref={canvasRef}
      className={styles.glowCanvas}
      aria-hidden
    />
  )
}

export default WindowEdgeGlow
