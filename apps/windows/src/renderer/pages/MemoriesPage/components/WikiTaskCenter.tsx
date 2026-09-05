import React, { useEffect, useState } from 'react'
import { RotateCcw, Square, Trash2, X } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import type { WikiLocalTask, WikiTaskPhase } from './useWikiTaskCenter'
import {
  extractLabel,
  formatRelativeTime,
  outcomeLabel,
  runStatusLabel,
} from './wikiStatusLabels'

export interface WikiTaskCenterProps {
  readonly open: boolean
  readonly tasks: readonly WikiLocalTask[]
  readonly onClose: () => void
  readonly onRetry: (task: WikiLocalTask) => void
  readonly onDismiss: (taskId: string) => void
  /** migrate review 待确认时打开映射预览 */
  readonly onOpenMigrateReview?: () => void
}

const TASK_SECTIONS: readonly {
  phase: WikiTaskPhase
  title: string
}[] = [
  { phase: 'failed', title: '失败' },
  { phase: 'running', title: '进行中' },
  { phase: 'succeeded', title: '最近完成' },
]

/**
 * 格式化任务进度；无确定进度时返回对应中文状态。
 */
function formatTaskStatus(task: WikiLocalTask): string {
  if (task.phase === 'running' && task.progress) {
    return `${task.progress.done}/${task.progress.total}`
  }
  return runStatusLabel(task.phase === 'succeeded' ? 'succeeded' : task.phase)
}

/**
 * 渲染归档运行的逐项明细。
 */
const WikiTaskRunDetail: React.FC<{ task: WikiLocalTask }> = ({ task }) => {
  const items = task.runDetail?.items ?? []
  if (items.length === 0) return null

  return (
    <details className="wiki-task-center-detail">
      <summary>查看明细（{items.length}）</summary>
      {items.map((item) => (
        <div className="wiki-task-center-detail-item" key={`${item.inboxId}-${item.path}`}>
          <div className="wiki-task-center-detail-heading">
            <strong>{item.title}</strong>
            <span>{outcomeLabel(item.outcome)} · {extractLabel(item.extract)}</span>
          </div>
          <p>{item.path}</p>
          {item.reason && <p>{item.reason}</p>}
        </div>
      ))}
    </details>
  )
}

/**
 * 渲染单个任务及其状态、错误、历史明细与可用操作。
 */
const WikiTaskItem: React.FC<{
  task: WikiLocalTask
  onRetry: (task: WikiLocalTask) => void
  onDismiss: (taskId: string) => void
  onOpenMigrateReview?: () => void
}> = ({ task, onRetry, onDismiss, onOpenMigrateReview }) => {
  const [cancelBusy, setCancelBusy] = useState(false)

  /** 调用 migrate 停止回调并防止重复点击 */
  const handleCancel = async (): Promise<void> => {
    if (!task.onCancel || cancelBusy) return
    setCancelBusy(true)
    try {
      await task.onCancel()
    } finally {
      setCancelBusy(false)
    }
  }

  return (
  <article className={`wiki-task-center-item wiki-task-center-item--${task.phase}`}>
    <div className="wiki-task-center-item-heading">
      <div>
        <strong>{task.title}</strong>
        <span>{formatRelativeTime(task.finishedAt ?? task.createdAt)}</span>
      </div>
      <span className={`wiki-task-center-status wiki-task-center-status--${task.phase}`}>
        {formatTaskStatus(task)}
      </span>
    </div>
    {task.detail && <p className="wiki-task-center-message">{task.detail}</p>}
    {task.currentItem && (
      <p className="wiki-task-center-message">当前：{task.currentItem}</p>
    )}
    {task.error && <p className="wiki-task-center-error">{task.error}</p>}
    <WikiTaskRunDetail task={task} />
    {task.phase === 'running' && task.onCancel && (
      <div className="wiki-task-center-actions">
        <Button
          variant="secondary"
          size="sm"
          disabled={cancelBusy || task.cancelRequested}
          onClick={() => void handleCancel()}
        >
          <Square size={12} />
          {task.cancelRequested ? '正在停止…' : '停止'}
        </Button>
      </div>
    )}
    {task.phase !== 'running' && (
      <div className="wiki-task-center-actions">
        {task.kind === 'migrate' && task.migratePhase === 'review' && onOpenMigrateReview && (
          <Button variant="secondary" size="sm" onClick={onOpenMigrateReview}>
            查看映射
          </Button>
        )}
        {task.retryable && (
          <Button variant="secondary" size="sm" onClick={() => onRetry(task)}>
            <RotateCcw size={12} />
            重试
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`移除任务：${task.title}`}
          onClick={() => onDismiss(task.id)}
        >
          <Trash2 size={12} />
          移除
        </Button>
      </div>
    )}
  </article>
  )
}

/**
 * 在 Wiki 工作区右侧展示当前任务与归档运行历史。
 */
export const WikiTaskCenter: React.FC<WikiTaskCenterProps> = ({
  open,
  tasks,
  onClose,
  onRetry,
  onDismiss,
  onOpenMigrateReview,
}) => {
  useEffect(() => {
    if (!open) return undefined

    /** 按 Escape 键关闭任务中心。 */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="wiki-task-center-overlay">
      <button
        type="button"
        className="wiki-task-center-mask"
        aria-label="关闭任务中心"
        onClick={onClose}
      />
      <aside
        className="wiki-task-center-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="任务中心"
      >
        <header className="wiki-task-center-header">
          <div>
            <h2>任务中心</h2>
            <p>查看 Wiki 后台任务与最近运行历史</p>
          </div>
          <Button variant="ghost" size="sm" aria-label="关闭任务中心" onClick={onClose}>
            <X size={16} />
          </Button>
        </header>

        <div className="wiki-task-center-content">
          {tasks.length === 0 && <p className="wiki-task-center-empty">暂无任务记录</p>}
          {TASK_SECTIONS.map((section) => {
            const sectionTasks = tasks
              .filter((task) => task.phase === section.phase)
              .sort((left, right) => right.createdAt - left.createdAt)
            if (sectionTasks.length === 0) return null
            return (
              <section className="wiki-task-center-section" key={section.phase}>
                <h3>{section.title}</h3>
                {sectionTasks.map((task) => (
                  <WikiTaskItem
                    key={task.id}
                    task={task}
                    onRetry={onRetry}
                    onDismiss={onDismiss}
                    onOpenMigrateReview={onOpenMigrateReview}
                  />
                ))}
              </section>
            )
          })}
        </div>
      </aside>
    </div>
  )
}

export default WikiTaskCenter
