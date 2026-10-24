import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { BackgroundTask } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import type { BackgroundTaskOutput } from '../../../../../shared/agent-runtime-events'
import { formatTaskElapsed } from './format'
import {
  detectCodeFence,
  MediaThumbStrip,
  ResultPreviewPanel,
  tryParseJsonResult,
} from './ResultPreviewPanel'
import {
  deriveTaskHealth,
  hasAlertLogs,
  HEALTH_LABEL,
  resolveStepWaitStart,
} from './taskHealth'
import { TaskLogs } from './TaskLogs'
import { TaskMilestones } from './TaskMilestones'
import { TaskProgressBar } from './TaskProgressBar'
import styles from './BackgroundTaskCard.module.css'

const STATUS_TEXT: Record<BackgroundTask['status'], string> = {
  running: '后台执行中',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 取消后台任务：走命令总线，状态由主进程回推 agent:background-task 更新 */
async function cancelBackgroundTask(taskId: string): Promise<void> {
  const api = (window as unknown as {
    electronAPI?: { agentRuntime?: { sendCommand?: (cmd: unknown) => Promise<unknown> } }
  }).electronAPI
  // 主进程不认识这个任务（历史残留卡片 / 重启后丢失）时就地收尾，
  // 否则按钮永远停在「中断」，用户点了毫无反应
  const settleLocally = async (): Promise<void> => {
    const storeMod = await import('../../../../hooks/business/useAgentRuntime/agent-runtime-store')
    const sessionKey = storeMod.runtimeStore.getState().currentSessionKey
    if (sessionKey) storeMod.markBackgroundTaskCancelled(sessionKey, taskId)
  }
  try {
    const result = (await api?.agentRuntime?.sendCommand?.({
      type: 'background-task:cancel',
      taskId,
    })) as { ok?: boolean } | undefined
    if (result?.ok === false) await settleLocally()
  } catch {
    await settleLocally()
  }
}

/** 暂停/恢复：只对轮询型任务有闸门，主进程不支持时返回 ok:false（UI 已按 pausable 隐藏按钮） */
function setBackgroundTaskPaused(taskId: string, paused: boolean): void {
  const api = (window as unknown as {
    electronAPI?: { agentRuntime?: { sendCommand?: (cmd: unknown) => Promise<unknown> } }
  }).electronAPI
  void api?.agentRuntime?.sendCommand?.({ type: 'background-task:pause', taskId, paused })
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

const PauseGlyph: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <line x1="9" y1="6" x2="9" y2="18" />
    <line x1="15" y1="6" x2="15" y2="18" />
  </svg>
)

const StatusIcon: React.FC<{ status: BackgroundTask['status'] }> = ({ status }) => {
  if (status === 'running') return <Spinner />
  if (status === 'paused') return <PauseGlyph />
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
 * 产出文件清单：随卡片一起展开，有地址的做成外链——
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

/**
 * 单条后台任务卡：折叠头显示标签/状态/健康态/耗时；进度区可点展开。
 * 折叠态媒体缩略图可直接开灯箱；有告警时默认展开日志。
 */
const BackgroundTaskCard: React.FC<{ task: BackgroundTask }> = ({ task }) => {
  const running = task.status === 'running'
  const active = running || task.status === 'paused'
  const alertLogs = hasAlertLogs(task.logs)
  const [expanded, setExpanded] = useState(
    () => active || alertLogs || (task.milestones?.length ?? 0) > 0,
  )
  const structuredResult = Boolean(
    task.result && (detectCodeFence(task.result) || tryParseJsonResult(task.result)),
  )
  const detail = task.error ?? (structuredResult ? task.summary : (task.result ?? task.summary))
  const outputCount = task.outputs?.length ?? 0
  const showProgress = active || typeof task.progress === 'number'
  const hasMediaPreview = Boolean(
    task.outputs?.some(
      (output) =>
        Boolean(output.previewUrl ?? output.url) &&
        (output.kind === 'image' || output.kind === 'video' || output.kind === 'audio'),
    ),
  )
  const hasContent = Boolean(detail)
    || outputCount > 0
    || showProgress
    || (task.logs?.length ?? 0) > 0
    || (task.milestones?.length ?? 0) > 0
  const statusText = running && task.note ? task.note : STATUS_TEXT[task.status]

  // 运行中每秒刷新耗时 / 本步等待 / 健康态（暂停时不再走动）
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  const now = Date.now()
  const health = deriveTaskHealth({
    status: task.status,
    startedAt: task.startedAt,
    logs: task.logs,
    milestones: task.milestones,
    now,
  })
  const stepWaitStart = resolveStepWaitStart(task.startedAt, task.milestones)

  /** 展开或收起详情区 */
  const toggleExpanded = (): void => {
    if (!hasContent) return
    setExpanded((value) => !value)
  }

  return (
    <div
      role="listitem"
      className={clsx(
        styles.card,
        running && styles.running,
        task.status === 'failed' && styles.failed,
        health === 'warn' && styles.healthWarn,
        health === 'error' && styles.healthError,
        health === 'stuck' && styles.healthStuck,
      )}
    >
      <div className={styles.headerRow}>
        <button
          type="button"
          className={styles.header}
          onClick={toggleExpanded}
          aria-expanded={hasContent ? expanded : undefined}
          disabled={!hasContent}
        >
          <span className={styles.icon}>
            <StatusIcon status={task.status} />
          </span>
          <span className={styles.title} title={task.toolName}>
            {task.label}
          </span>
          <span className={styles.status}>{statusText}</span>
          <span
            className={clsx(styles.health, styles[`healthBadge_${health}`])}
            data-health={health}
          >
            {HEALTH_LABEL[health]}
          </span>
          <span className={styles.elapsed}>
            {formatTaskElapsed(task.startedAt, task.endedAt ?? task.pausedAt)}
          </span>
          {outputCount > 0 && (
            <span className={styles.outputCount}>产出 {outputCount}</span>
          )}
          {hasContent && (
            <span className={styles.chevron}>
              {expanded
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>}
            </span>
          )}
        </button>
        {running && task.pausable && (
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={() => setBackgroundTaskPaused(task.taskId, true)}
            title="暂停跟进（远端作业继续跑，恢复后接着等）"
            aria-label="暂停后台任务"
          >
            暂停
          </button>
        )}
        {task.status === 'paused' && (
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={() => setBackgroundTaskPaused(task.taskId, false)}
            title="恢复跟进"
            aria-label="恢复后台任务"
          >
            恢复
          </button>
        )}
        {running && (
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={() => void cancelBackgroundTask(task.taskId)}
            title="中断这个后台任务"
            aria-label="中断后台任务"
          >
            中断
          </button>
        )}
      </div>
      {showProgress && (
        <TaskProgressBar
          progress={task.progress}
          currentStep={task.currentStep}
          startTime={task.startedAt}
          stepWaitStart={stepWaitStart}
          endedAt={task.endedAt}
          pausedAt={task.pausedAt}
          status={task.status}
          now={now}
          onActivate={toggleExpanded}
        />
      )}
      {/* 折叠态也可点的媒体缩略图；展开后由 ResultPreviewPanel 接管完整预览 */}
      {!expanded && hasMediaPreview && (
        <MediaThumbStrip outputs={task.outputs} />
      )}
      {expanded && (
        <>
          <TaskMilestones milestones={task.milestones} />
          <TaskLogs logs={task.logs} defaultExpanded={alertLogs} />
          <ResultPreviewPanel outputs={task.outputs} result={task.result} />
          {task.outputs && task.outputs.length > 0 && (
            <BackgroundTaskOutputs outputs={task.outputs} />
          )}
          {detail && (
            <pre className={clsx(styles.detail, task.status === 'failed' && styles.detailError)}>
              {detail}
            </pre>
          )}
        </>
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
