import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { BackgroundTask } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import type { BackgroundTaskOutput } from '../../../../../shared/agent-runtime-events'
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

const OUTPUT_KIND_TEXT: Record<BackgroundTaskOutput['kind'], string> = {
  video: '视频',
  image: '图片',
  audio: '音频',
  file: '文件',
}

/**
 * 产出文件清单：终态后直接可见（不必展开），有地址的做成外链——
 * 主窗口的 window.open 拦截会交给系统浏览器打开。
 */
const BackgroundTaskOutputs: React.FC<{ outputs: readonly BackgroundTaskOutput[] }> = ({ outputs }) => (
  <ul className={styles.outputs} aria-label="产出文件">
    {outputs.map((output) => (
      <li key={`${output.kind}:${output.path}`} className={styles.outputItem}>
        <span className={styles.outputKind}>{OUTPUT_KIND_TEXT[output.kind]}</span>
        {output.url ? (
          <a
            className={styles.outputLink}
            href={output.url}
            target="_blank"
            rel="noreferrer"
            title={output.path}
          >
            {output.name}
          </a>
        ) : (
          <span className={styles.outputName} title={output.path}>{output.name}</span>
        )}
      </li>
    ))}
  </ul>
)

/** 单条后台任务卡：折叠头显示标签/状态/耗时；运行中可中断；产出文件直接列出，展开看完整结果或失败原因 */
const BackgroundTaskCard: React.FC<{ task: BackgroundTask }> = ({ task }) => {
  const [expanded, setExpanded] = useState(false)
  const running = task.status === 'running'
  const detail = task.error ?? task.result ?? task.summary
  const statusText = running && task.note ? task.note : STATUS_TEXT[task.status]

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
          <span className={styles.status}>{statusText}</span>
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
      {task.outputs && task.outputs.length > 0 && <BackgroundTaskOutputs outputs={task.outputs} />}
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
