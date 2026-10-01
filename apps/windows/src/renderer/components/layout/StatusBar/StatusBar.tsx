/**
 * StatusBar - 底部状态条（原型 .sbar）
 *
 * 右侧 HUD：消息数 / token 上下行 / tok/s / 模型延迟 / 网络延迟 / 花费。
 * 上下文占用已在输入框上方显示，此处不重复。
 */

import React, { useEffect, useState } from 'react'
import { useAgentRuntimeState } from '../../../hooks/business/useAgentRuntime'
import { formatCostYuan } from '../../../../shared/model-pricing'
import { sessionMetrics } from './session-metrics'
import { getUsageLatency } from '../../../services/usage-service'
import { pingNetwork } from '../../../services/net-service'
import type { PingReport, PingResult } from '../../../../shared/net-latency-types'
import styles from './StatusBar.module.css'

/** 模型首字节延迟：最近 N 次 TTFB 中位数，主进程侧已聚合，这里低频取值 */
const LATENCY_POLL_MS = 5000
/** 网络延迟探测：与 TTFB 同节奏；慢网下靠在途去重自然退避，不会堆叠 */
const NET_PING_POLL_MS = 5000

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/** 单组延迟的 tooltip 文案：主数字为中位数，另附最小值与抖动 */
function fmtPing(r: PingResult | undefined): string {
  if (!r) return '—'
  if (!r.ok) return `离线（${r.error ?? '探测失败'}）`
  const parts = [`中位 ${r.ms} ms`]
  if (r.minMs != null) parts.push(`最低 ${r.minMs} ms`)
  if (r.jitterMs != null) parts.push(`抖动 ${r.jitterMs} ms`)
  return parts.join(' · ')
}

/** 探测本身失败（如 IPC 异常）时的报告：都按离线处理，避免状态点一直转 */
function failedReport(reason: string): PingReport {
  return {
    domestic: { group: 'domestic', ok: false, error: reason },
    international: { group: 'international', ok: false, error: reason },
    best: null,
  }
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
  const [netPing, setNetPing] = useState<PingReport | null>(null)

  useEffect(() => {
    let alive = true
    const pull = async () => {
      const res = await getUsageLatency()
      if (alive && res.data) setLatency(res.data)
    }
    void pull()
    const timer = window.setInterval(() => void pull(), LATENCY_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  // 网络延迟轮询：带在途去重，避免上一轮（含预热 + 多采样）还没回来又叠一轮
  useEffect(() => {
    let alive = true
    let inFlight = false
    const pull = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const report = await pingNetwork()
        if (alive) setNetPing(report)
      } catch {
        if (alive) setNetPing(failedReport('探测失败'))
      } finally {
        inFlight = false
      }
    }
    void pull()
    const timer = window.setInterval(() => void pull(), NET_PING_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const { upTokens, downTokens, costYuan, hasPrice } = sessionMetrics(messages, modelId)
  const lastMetrics = [...messages].reverse().find((m) => m.streamMetrics)?.streamMetrics

  // 自适应：国内 / 国外里取可达且延迟最低的那组
  const bestPing = netPing?.best ? netPing[netPing.best] : null
  const netMs = bestPing?.ok ? bestPing.ms : undefined
  const netState: 'init' | 'ok' | 'off' = !netPing ? 'init' : bestPing?.ok ? 'ok' : 'off'
  const netTitle = netPing
    ? `网络延迟（HTTP 往返，非 ICMP）\n国内 ${fmtPing(netPing.domestic)}\n国外 ${fmtPing(netPing.international)}`
    : '网络延迟探测中'

  return (
    <footer className={styles.sbar}>
      <i className={`${styles.item} ${styles.slogan}`} title="灵栖产品标语">
        <span className={styles.sloganText}>
          灵有所栖，人有所归。不催不诫，如友如时。
        </span>
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
          <Tick>{formatCostYuan(hasPrice ? costYuan : undefined)}</Tick>
        </i>
        <span className={styles.sep} />
        <i className={styles.item} title={netTitle}>
          <span className={styles.netDot} data-state={netState} aria-hidden="true" />
          网络 <Tick>{netMs ?? '—'}</Tick> ms
        </i>
      </div>
    </footer>
  )
}
