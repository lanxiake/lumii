/**
 * AgentDashboard — 并行子 Agent 看板
 *
 * 解决的问题：主 Agent 并行派了多个子 Agent 时，用户只能看到「处理中」一个笼统状态，
 * 不知道有几个在跑、各自跑到哪、哪个最慢。
 *
 * 数据来源是主进程已有的 `agent:activity:snapshot`（见 bridge-lifecycle.pushActivitySnapshot）：
 * 每个实例的 state / mode / broker status / startedAt 都在里面，只是此前没人消费。
 *
 * 刻意不做的事（YAGNI）：
 * - 不做「已完成 N 个」计数——子实例投递完就 destroy，快照里直接消失；
 *   伪造一个计数只会和真实事件对不上。已完成的轨迹在委托卡片里本来就完整。
 * - 不做日志流/媒体预览——每个子运行的完整时间线已经在 SpawnAgentCard 内部渲染，
 *   看板再抄一份只是重复。
 * - 不做虚拟滚动——并发上限是 10（SUBAGENT_DEFAULTS.hardMaxConcurrent），
 *   10 张轻量卡片不需要窗口化。
 *
 * 只在 ≥2 个子 Agent 同时活动时出现：单个子 Agent 的场景，委托卡片已经足够。
 */

import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import type { ActiveAgent } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import styles from './AgentDashboard.module.css'

/** 少于这个数量不显示看板（单个子 Agent 看委托卡片就够了） */
const MIN_VISIBLE_AGENTS = 2

/** 耗时格式化：秒级以下给秒，超过一分钟给「分m秒s」 */
function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return rem > 0 ? `${min}m${rem}s` : `${min}m`
}

/**
 * 无进展多久算「疑似卡住」。
 *
 * broker 的 stale 判定是 180s（SUBAGENT_DEFAULTS.staleIdleMs，到点会自动 finalize），
 * 这里取一半：让用户在主进程动手之前先看到提示，而不是等它自己判死。
 */
const STALL_HINT_MS = 90_000

/** 卡片状态。只有四种：还在跑、跑完了但实例还活着、失败、空闲待命 */
type CardStatus = 'running' | 'done' | 'failed' | 'idle'

function resolveStatus(agent: ActiveAgent): CardStatus {
  if (agent.status === 'failed' || agent.state === 'error') return 'failed'
  if (agent.status && agent.status !== 'running') return 'done'
  if (agent.state === 'running' || agent.state === 'paused') return 'running'
  return 'idle'
}

const STATUS_TEXT: Record<CardStatus, string> = {
  running: '执行中',
  done: '已完成',
  failed: '失败',
  idle: '待命',
}

const Spinner: React.FC = () => (
  <svg
    className={styles.spinner}
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
)

const StatusIcon: React.FC<{ status: CardStatus }> = ({ status }) => {
  if (status === 'running') return <Spinner />
  if (status === 'failed') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    )
  }
  if (status === 'done') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  }
  return <span className={styles.idleDot} aria-hidden="true" />
}

export interface AgentDashboardProps {
  /** 会话级活动实例（含主 Agent；本组件内部只留子 Agent） */
  agents: readonly ActiveAgent[]
  /**
   * 取消某个子 Agent。不传则不显示取消按钮（例如只读场景）。
   *
   * 取消走 `agentInstance:abort`：它会中止该实例（含其工具调用），
   * 实例销毁后主进程会推新的活动快照，卡片随之消失——不需要本地改状态。
   */
  onCancel?: (instanceId: string) => void
}

/**
 * 跳到该子 Agent 的详细轨迹。
 *
 * 子 Agent 没有独立会话（与父共用 conversationId），所以「详情页」就是上面
 * 委托卡片里内嵌的那块运行轨迹——按 `data-instance-id` 找到它滚进视野即可。
 */
function scrollToRun(instanceId: string): void {
  const el = document.querySelector(`[data-instance-id="${CSS.escape(instanceId)}"]`)
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

export const AgentDashboard: React.FC<AgentDashboardProps> = ({ agents, onCancel }) => {
  const subAgents = useMemo(() => agents.filter((agent) => agent.isSubAgent), [agents])
  /**
   * 一旦并行过就算「已进入并行态」，直到子 Agent 全部退场。
   *
   * 不能让显示条件严格跟着「≥2」走：3 个里跑完 2 个会瞬间只剩 1 个，面板会在
   * 用户眼皮底下消失又出现（实测 2026-10-24）。粘住后是「从并行收敛到收尾」，
   * 视觉连续，也让最后那个还能点取消。
   */
  const [everParallel, setEverParallel] = useState(false)
  const isParallel = subAgents.length >= MIN_VISIBLE_AGENTS
  useEffect(() => {
    if (isParallel) setEverParallel(true)
    else if (subAgents.length === 0) setEverParallel(false)
  }, [isParallel, subAgents.length])
  // subAgents 归零的那一帧 everParallel 还是 true（effect 还没跑），别渲染空面板
  const visible = subAgents.length > 0 && (isParallel || everParallel)

  // 计时只在看板可见时跑，且整块共用一个 timer：10 张卡各自 setInterval 是纯浪费
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!visible) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [visible])

  if (!visible) return null

  const runningCount = subAgents.filter((agent) => resolveStatus(agent) === 'running').length

  return (
    <section className={styles.dashboard} aria-label="并行子 Agent 看板">
      <header className={styles.header}>
        <span className={styles.title}>并行执行</span>
        <span className={styles.summary}>
          {subAgents.length} 个
          {runningCount > 0 ? ` · ${runningCount} 个进行中` : ' · 均已结束'}
        </span>
      </header>
      <ul className={styles.list}>
        {subAgents.map((agent) => {
          const status = resolveStatus(agent)
          const lastBeat = agent.lastProgressAt ?? agent.startedAt
          const stalled = status === 'running' && lastBeat !== undefined && now - lastBeat > STALL_HINT_MS
          return (
            <li key={agent.instanceId} className={clsx(styles.card, styles[`card--${status}`])}>
              <span className={clsx(styles.status, styles[`status--${status}`])}>
                <StatusIcon status={status} />
                {STATUS_TEXT[status]}
              </span>
              <span className={styles.name} title={agent.name}>
                {agent.name}
              </span>
              {agent.mode === 'async' && <span className={styles.modeTag}>后台</span>}
              {stalled && <span className={styles.stalled}>疑似卡住</span>}
              <span className={styles.elapsed}>
                {agent.startedAt ? formatElapsed(now - agent.startedAt) : '—'}
              </span>
              <button
                type="button"
                className={styles.detail}
                onClick={() => scrollToRun(agent.instanceId)}
                title="跳到这位专家的执行过程"
              >
                详情
              </button>
              {onCancel && status === 'running' && (
                <button
                  type="button"
                  className={styles.cancel}
                  onClick={() => onCancel(agent.instanceId)}
                >
                  取消
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
