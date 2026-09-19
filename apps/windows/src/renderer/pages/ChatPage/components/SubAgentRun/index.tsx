/**
 * SubAgentRunBlock — 被委派子 Agent 的运行块
 *
 * 存在理由（2026-09-14，见 docs/plans/专项Agent/08-委托可见性.md §4）：
 * 子 Agent 与父共用同一个会话，此前它的 thinking / 工具被**纯拼接进父气泡的 parts**，
 * 于是父的「执行过程」被污染，且父消息 `isStreaming=true` 会让所有思考块同时显活
 * ——用户看到「两个执行过程都在输出思考」。
 *
 * 本组件让子 Agent 的运行成为**有身份、有边界、可折叠**的独立单元：
 * 谁在跑（专家名）、跑到哪（状态 + 工具计数）、干了什么（展开看轨迹）。
 * 父气泡的「执行过程」从此只属于父。
 */

import React, { useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { SubAgentRun } from '../ChatContainer/sub-agent-runs'
import styles from './SubAgentRun.module.css'

/** 单行截断：失败原因常带 provider 原文，头部只留关键句，全文在展开体里给 */
function truncate(text: string, max: number): string {
  const one = text.replace(/\s*\n+\s*/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

export interface SubAgentRunBlockProps {
  run: SubAgentRun
  /**
   * 嵌在委托卡片内部时置 true：去掉外层描边与背景，避免「卡中卡」。
   */
  embedded?: boolean
  /** 展开体：该运行的轨迹时间线 */
  children: React.ReactNode
}

export const SubAgentRunBlock: React.FC<SubAgentRunBlockProps> = ({
  run,
  embedded = false,
  children,
}) => {
  // 流式中默认展开（用户在等结果），完成后默认收起（避免多条子运行堆叠刷屏）
  const [expanded, setExpanded] = useState(run.isStreaming)

  const toolCount = run.parts.filter((part) => part.type === 'tool').length
  /**
   * 四态。优先级：执行中 → 已中断 → 失败 → 已完成。
   * 中断不是失败（中止/重启残留没有产出，但不该报警），失败必须给出原因——
   * 否则死掉的子运行会和正常跑完的一模一样显示「已完成」，用户无从判断。
   */
  const status: 'running' | 'interrupted' | 'failed' | 'done' = run.isStreaming
    ? 'running'
    : run.interrupted
      ? 'interrupted'
      : run.error
        ? 'failed'
        : 'done'
  const statusText = { running: '执行中', interrupted: '已中断', failed: '失败', done: '已完成' }[status]

  return (
    <div
      className={clsx(styles.run, embedded && styles['run--embedded'], run.isStreaming && styles['run--streaming'])}
      data-testid="sub-agent-run"
      data-instance-id={run.instanceId}
      data-streaming={run.isStreaming ? 'true' : 'false'}
      data-status={status}
    >
      <button
        type="button"
        className={clsx(styles.header, expanded && styles['header--expanded'])}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={expanded ? '收起该专家的执行过程' : '展开查看该专家的执行过程'}
      >
        <ChevronRight
          size={12}
          className={clsx(styles.chevron, expanded && styles['chevron--open'])}
        />
        <span className={styles.name}>{run.label}</span>
        <span className={clsx(styles.status, styles[`status--${status}`])}>
          {run.isStreaming && <Loader2 size={11} className={styles.spinner} />}
          {statusText}
        </span>
        {toolCount > 0 && <span className={styles.meta}>{toolCount} 个工具</span>}
        <span className={styles.hint}>{expanded ? '收起' : '过程'}</span>
      </button>
      {/* 失败原因常驻头部下方一行（截断）；全文在展开体顶部 */}
      {status === 'failed' && (
        <div className={styles.errorLine}>{truncate(run.error ?? '', 160)}</div>
      )}
      {expanded && (
        <div className={styles.body}>
          {status === 'failed' && (
            <div className={styles.errorFull}>{run.error}</div>
          )}
          {children}
          {/* 底部收起：长轨迹读到底后就地收起，不必再滑回顶部点头部 */}
          <button
            type="button"
            className={styles.collapse}
            onClick={() => setExpanded(false)}
          >
            收起
          </button>
        </div>
      )}
    </div>
  )
}
