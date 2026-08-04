/**
 * PetDebugOverlay - dev 模式可观测指标悬浮层（生产构建不渲染）
 *
 * 显示 pet-metrics 四项指标：模式切换 / 模型加载 / 口型延迟 / 渲染帧率
 */

import React, { useEffect, useState } from 'react'
import type { PetMetricsSnapshot } from '../telemetry/pet-metrics'
import { petMetrics } from '../telemetry/pet-metrics'

/** 每 1s 刷新一次（debug 用，不影响生产性能） */
const REFRESH_MS = 1000

export const PetDebugOverlay: React.FC = () => {
  if (!import.meta.env.DEV) return null

  const [snap, setSnap] = useState<PetMetricsSnapshot>(petMetrics.snapshot())

  useEffect(() => {
    const id = setInterval(() => setSnap(petMetrics.snapshot()), REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        top: 8,
        left: 8,
        pointerEvents: 'none',
        background: 'rgba(0,0,0,0.55)',
        color: '#0f0',
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 1.7,
        padding: '4px 8px',
        borderRadius: 6,
        userSelect: 'none',
        zIndex: 9999,
      }}
    >
      <div>switch {snap.modeSwitchDurationMs} ms</div>
      <div>load   {snap.modelLoadDurationMs} ms</div>
      <div>lip    {snap.lipSyncLatencyMs} ms</div>
      <div>fps    {snap.renderFps}</div>
    </div>
  )
}

export default PetDebugOverlay
