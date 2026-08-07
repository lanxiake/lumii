/**
 * StatusBar - 底部状态条（原型 .sbar）
 *
 * 右侧 HUD：消息数 / token 上下行 / tok/s / 延迟 / 花费。
 * 上下文占用已在输入框上方显示，此处不重复。
 */

import React, { useEffect, useState } from 'react'
import { useAgentRuntimeState } from '../../../hooks/business/useAgentRuntime'
import { formatCostCny } from '../../../../shared/model-pricing'
import { sessionMetrics } from './session-metrics'
import styles from './StatusBar.module.css'

/** 延迟读数来自最近 N 次 TTFB 中位数，主进程侧已聚合，这里只需低频取值 */
const LATENCY_POLL_MS = 5000

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/**
 * 数值变化时跳一下（全局 .mt-tick）。
 * key 用值本身：值一变就重挂载，CSS 动画自然重播，不用 state 也不用 timer。
 */
const Tick: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <b key={String(children)} className="mt-tick">
    {children}
  </b>
)

export const StatusBar: React.FC = () => {
  const messages = useAgentRuntimeState((s) => s.messages)
  const modelId = useAgentRuntimeState((s) => s.currentLlmModelId)
  const [latency, setLatency] = useState<{ medianMs?: number; isLocal: boolean }>({ isLocal: false })

  useEffect(() => {
    let alive = true
    const pull = async () => {
      const res = await window.electronAPI.usage.latency()
      if (alive && res.data) setLatency(res.data)
    }
    void pull()
    const timer = window.setInterval(() => void pull(), LATENCY_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const { upTokens, downTokens, costCents, hasPrice } = sessionMetrics(messages, modelId)
  const lastMetrics = [...messages].reverse().find((m) => m.streamMetrics)?.streamMetrics

  return (
    <footer className={styles.sbar}>
      <i className={styles.item}>
        <b>灵有所栖，人有所归。不催不诫，如友如时。</b>
      </i>

      <span className={styles.spacer} />

      <div className={styles.hud} title="当前会话观测">
        <i className={styles.item}>
          <Tick>{messages.length}</Tick> 条
        </i>
        <span className={styles.sep} />
        <i className={styles.item}>
          ↑<Tick>{fmtTokens(upTokens)}</Tick> ↓<Tick>{fmtTokens(downTokens)}</Tick> tok
        </i>
        <span className={styles.sep} />
        <i className={styles.item}>
          <Tick>{lastMetrics ? Math.round(lastMetrics.tokensPerSecond) : '—'}</Tick> tok/s
        </i>
        <span className={styles.sep} />
        <i className={styles.item} title={latency.isLocal ? '本机推理，无网络往返' : '到模型 provider 的首字节延迟'}>
          <Tick>{latency.medianMs ?? '—'}</Tick> {latency.isLocal ? 'ms 本机' : 'ms'}
        </i>
        <span className={styles.sep} />
        {/* 无价目表的模型只记 token 不记花费，显示「—」而不是 0 */}
        <i className={styles.item} title="按各模型公开单价本地估算">
          <Tick>{formatCostCny(hasPrice ? costCents : undefined)}</Tick>
        </i>
      </div>
    </footer>
  )
}

export default StatusBar
