/**
 * 实时波形可视化组件
 * 使用 Web Audio AnalyserNode 绘制麦克风/TTS 实时波形
 */
import React, { useRef, useEffect } from 'react'
import type { VoiceCallState } from '../../../../../shared/voice-events.js'
import styles from './VoiceCallPanel.module.css'

interface WaveformVisualizerProps {
  state: VoiceCallState | 'idle'
  /** 来自 useVoiceCall 的 AnalyserNode（可选，无时降级为 CSS 动画） */
  analyserNode?: AnalyserNode | null
}

/* canvas 画不了 CSS 变量，这里映射到 token 名，运行时取计算值，
   避免写死 hex 在浅色主题下失真 */
const STATE_TOKEN: Record<string, string> = {
  listening:   '--mt-accent-500',
  recognizing: '--mt-warning',
  thinking:    '--mt-violet',
  speaking:    '--mt-success',
  error:       '--mt-error',
}

const readToken = (name: string, fallback: string): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export function WaveformVisualizer({ state, analyserNode }: WaveformVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)

  const isPulsing = state === 'listening' || state === 'recognizing'
  const color = readToken(STATE_TOKEN[state] ?? '--mt-fg-4', '#94a3b8')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width
    const H = canvas.height
    const barCount = 32

    // 说话/聆听态用 violet→accent 竖向渐变，与通话条的紫框呼应
    const grad = ctx.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0, readToken('--mt-violet', '#8b5cf6'))
    grad.addColorStop(1, readToken('--mt-accent-500', '#3b82f6'))
    const fill = isPulsing || state === 'speaking' ? grad : color

    const drawBars = (freqData: Uint8Array | null) => {
      ctx.clearRect(0, 0, W, H)

      const barW = Math.floor(W / barCount) - 1
      for (let i = 0; i < barCount; i++) {
        let barH: number
        if (freqData) {
          // 实时频域数据（0~255），映射到 bar 高度
          barH = Math.max(2, (freqData[i] / 255) * H)
        } else if (isPulsing) {
          // 无 analyser 时用正弦波模拟
          const t = Date.now() / 300
          barH = Math.max(3, (0.5 + 0.4 * Math.sin(t + i * 0.4)) * H * 0.6)
        } else {
          barH = 3
        }

        const x = i * (barW + 1)
        const y = (H - barH) / 2

        ctx.fillStyle = fill
        ctx.beginPath()
        ctx.roundRect(x, y, barW, barH, 2)
        ctx.fill()
      }
    }

    let bufferLength = 0
    let dataArray: Uint8Array | null = null

    if (analyserNode) {
      analyserNode.fftSize = 64
      bufferLength = analyserNode.frequencyBinCount
      dataArray = new Uint8Array(bufferLength)
    }

    const animate = () => {
      if (analyserNode && dataArray) {
        analyserNode.getByteFrequencyData(dataArray as Uint8Array<ArrayBuffer>)
        // 取前 barCount 个频段（低频更有说话感）
        const slice = new Uint8Array(dataArray.slice(0, barCount))
        drawBars(slice)
      } else {
        drawBars(null)
      }
      rafRef.current = requestAnimationFrame(animate)
    }

    animate()
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyserNode, isPulsing, color, state])

  // 静止状态显示圆形图标
  if (state === 'idle' || state === 'ending') {
    return (
      <div className={styles['voice-waveform']}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="var(--mt-fg-4)">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V23h2v-2.06A9 9 0 0 0 21 12v-2h-2z"/>
        </svg>
      </div>
    )
  }

  return (
    <div className={styles['voice-waveform']}>
      <canvas
        ref={canvasRef}
        width={120}
        height={36}
        style={{ display: 'block' }}
        aria-hidden="true"
      />
    </div>
  )
}

export default WaveformVisualizer
