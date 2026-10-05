import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { BackgroundTask } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import { formatTaskElapsed } from './format'
import styles from './BackgroundTaskCard.module.css'

const STATUS_TEXT: Record<BackgroundTask['status'], string> = {
  running: '后台执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 取消后台任务：走命令总线，状态由主进程回推 agent:background-task 更新 */
function cancelBackgroundTask(taskId: string): void {
  const api = (window as unknown as {
    electronAPI?: { agentRuntime?: { sendCommand?: (cmd: unknown) => Promise<unknown> } }
  }).electronAPI
  void api?.agentRuntime?.sendCommand?.({ type: 'background-task:cancel', taskId })
}

const Spinner: React.FC = () => (
  <svg
    className={styles.spinner}
    width="13"
    height="13"
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

const StatusIcon: React.FC<{ status: BackgroundTask['status'] }> = ({ status }) => {
  if (status === 'running') return <Spinner />
  if (status === 'succeeded') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  }
  if (status === 'cancelled') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    )
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

/** 单条后台任务卡：折叠头显示标签/状态/耗时；运行中可中断；展开看产出或失败原因 */
const BackgroundTaskCard: React.FC<{ task: BackgroundTask }> = ({ task }) => {
  const [expanded, setExpanded] = useState(false)
  const running = task.status === 'running'
  const detail = task.error ?? task.summary

  // 运行中每秒刷新耗时
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  return (
    <div
      role="listitem"
      className={clsx(
        styles.card,
        running && styles.running,
        task.status === 'failed' && styles.failed,
      )}
    >
      <div className={styles.headerRow}>
        <button
          type="button"
          className={styles.header}
          onClick={() => detail && setExpanded((v) => !v)}
          aria-expanded={expanded}
          disabled={!detail}
        >
          <span className={styles.icon}>
            <StatusIcon status={task.status} />
          </span>
          <span className={styles.title} title={task.toolName}>
            {task.label}
          </span>
          <span className={styles.status}>{STATUS_TEXT[task.status]}</span>
          <span className={styles.elapsed}>
            {formatTaskElapsed(task.startedAt, task.endedAt)}
          </span>
          {detail && (
            <span className={styles.chevron}>
              {expanded
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>}
            </span>
          )}
        </button>
        {running && (
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={() => cancelBackgroundTask(task.taskId)}
            title="中断这个后台任务"
            aria-label="中断后台任务"
          >
            中断
          </button>
        )}
      </div>
      {expanded && detail && (
        <pre className={clsx(styles.detail, task.status === 'failed' && styles.detailError)}>
          {detail}
        </pre>
      )}
    </div>
  )
}

/**
 * 后台任务列表 —— 长耗时工具（如远程视频生成）后台化后在对话流内可见。
 * 运行中显示转圈与实时耗时、可中断；完成/失败可展开看结果。
 */
const BackgroundTaskList: React.FC<{ tasks: readonly BackgroundTask[] }> = ({ tasks }) => {
  if (tasks.length === 0) return null
  return (
    <div className={styles.list} role="list" aria-label="后台任务">
      {tasks.map((task) => (
        <BackgroundTaskCard key={task.taskId} task={task} />
      ))}
    </div>
  )
}

export { BackgroundTaskCard, BackgroundTaskList }
