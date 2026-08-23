/**
 * TodoPanel — 在对话流中展示当前 Todo 任务列表
 *
 * 从工作流工具调用中提取最新 TodoWrite 结果，
 * 支持点击展开/收起，让用户实时了解 Agent 的任务进度。
 */

import React, { useState, useMemo } from 'react'
import clsx from 'clsx'
import styles from './TodoPanel.module.css'

interface TodoTask {
  id?: string | number
  subject?: string
  status?: string
  description?: string
}

interface TodoPanelProps {
  /** 来自 workflowItems 或 runtimeMessages.toolCalls 的所有工具调用 */
  toolCalls: readonly {
    id: string
    name: string
    status: 'running' | 'completed' | 'failed' | 'error'
    result?: unknown
    output?: unknown
  }[]
  /** 紧凑模式：仅显示小图标，悬停时弹出完整列表 */
  compact?: boolean
  /**
   * inline：对话流内轻量卡片（默认）
   * rail：遗留左侧轨道样式
   * default：旧版面板样式
   */
  variant?: 'default' | 'rail' | 'inline'
  /** 默认是否展开（inline / default） */
  defaultExpanded?: boolean
}

function extractText(output: unknown): string | null {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    // { type: 'tool_result', content: [{ type: 'text', text: '...' }] } 格式
    const o = output as Record<string, unknown>
    if (Array.isArray(o.content)) {
      const texts = (o.content as Array<Record<string, unknown>>)
        .filter((c) => c.type === 'text')
        .map((c) => String(c.text ?? ''))
        .join('')
      if (texts) return texts
    }
    if (typeof o.text === 'string') return o.text
  }
  return null
}

function parsePayload(output: unknown): Record<string, unknown> | null {
  if (!output) return null
  try {
    // 优先从文本提取（处理 { content: [{ type:'text', text:'{"status":"ok","tasks":[...]}' }] } 格式）
    const text = extractText(output)
    if (text?.trim()) {
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        // text 不是 JSON，继续往下
      }
    }
    // 回退：对象本身就是 payload（如直接传入 { tasks: [...] }）
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      return output as Record<string, unknown>
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * 从所有 todo_write 工具调用中聚合出完整的任务列表：
 * 1. 找最后一个包含 tasks[] 的调用（batch_create 或 list）作为基础
 * 2. 对基础之后的每个 update 结果（包含单个 task）做合并覆盖
 */
function aggregateTasks(
  toolCalls: TodoPanelProps['toolCalls'],
): TodoTask[] | null {
  const todoCalls = toolCalls.filter(
    (tc) =>
      tc.name?.toLowerCase().includes('todo') &&
      (tc.status === 'completed' || tc.status === 'running'),
  )
  if (todoCalls.length === 0) return null

  // 找最后一个返回 tasks[] 的调用作为基础（batch_create / list，跳过 batch_update/update）
  let baseIdx = -1
  let baseTasks: TodoTask[] = []
  for (let i = todoCalls.length - 1; i >= 0; i--) {
    const tc = todoCalls[i]!
    const payload = parsePayload(tc.result ?? tc.output)
    // 跳过 batch_update/update 的结果，避免把局部更新列表误作基础
    if (payload && (payload.action === 'batch_update' || payload.action === 'update')) continue
    if (payload && Array.isArray(payload.tasks) && payload.tasks.length > 0) {
      baseIdx = i
      baseTasks = payload.tasks as TodoTask[]
      break
    }
  }

  // 若没有 tasks[] 基础，尝试从单个 task 构建
  if (baseIdx === -1) {
    for (let i = todoCalls.length - 1; i >= 0; i--) {
      const tc = todoCalls[i]!
      const payload = parsePayload(tc.result ?? tc.output)
      if (payload?.task && typeof payload.task === 'object') {
        baseTasks = [payload.task as TodoTask]
        baseIdx = i
        break
      }
    }
  }

  if (baseTasks.length === 0) return null

  // 将 baseIdx 之后的 update 结果（单个 task）合并到基础列表
  const taskMap = new Map<string | number, TodoTask>()
  for (const t of baseTasks) {
    const key = t.id ?? t.subject ?? JSON.stringify(t)
    taskMap.set(key as string | number, t)
  }

  for (let i = baseIdx + 1; i < todoCalls.length; i++) {
    const tc = todoCalls[i]!
    const payload = parsePayload(tc.result ?? tc.output)
    if (!payload) continue
    // update 返回单个 task
    if (payload.task && typeof payload.task === 'object') {
      const updated = payload.task as TodoTask
      const key = updated.id ?? updated.subject
      if (key !== undefined && taskMap.has(key as string | number)) {
        taskMap.set(key as string | number, { ...taskMap.get(key as string | number), ...updated })
      }
    }
    // batch_update 返回 tasks[]
    if (Array.isArray(payload.tasks)) {
      for (const updated of payload.tasks as TodoTask[]) {
        const key = updated.id ?? updated.subject
        if (key !== undefined) {
          if (taskMap.has(key as string | number)) {
            taskMap.set(key as string | number, { ...taskMap.get(key as string | number), ...updated })
          } else {
            taskMap.set(key as string | number, updated)
          }
        }
      }
    }
  }

  const result = Array.from(taskMap.values())
  return result.length > 0 ? result : null
}

function statusIcon(status?: string): string {
  switch (status) {
    case 'completed':
    case 'done':
      return '✓'
    case 'in_progress':
    case 'in-progress':
      return '◉'
    case 'failed':
    case 'cancelled':
      return '✕'
    case 'blocked':
      return '⊘'
    default:
      return '○'
  }
}

function statusClass(status?: string): string {
  switch (status) {
    case 'completed':
    case 'done':
      return styles.taskDone
    case 'in_progress':
    case 'in-progress':
      return styles.taskActive
    case 'failed':
    case 'cancelled':
      return styles.taskFailed
    default:
      return styles.taskPending
  }
}

function isDone(status?: string): boolean {
  return status === 'completed' || status === 'done'
}

function isActive(status?: string): boolean {
  return status === 'in_progress' || status === 'in-progress'
}

/** 排序权重：进行中 → 待办/受阻 → 已完成 → 已取消/失败 */
function statusRank(status?: string): number {
  if (isActive(status)) return 0
  if (isDone(status)) return 2
  if (status === 'cancelled' || status === 'failed') return 3
  return 1
}

/** 长列表里默认只展开前 N 条，其余折叠，避免长会话把界面刷满 */
const COLLAPSED_LIMIT = 8

export const TodoPanel: React.FC<TodoPanelProps> = ({
  toolCalls,
  compact = false,
  variant = 'default',
  defaultExpanded,
}) => {
  const initialExpanded =
    defaultExpanded ?? (variant === 'inline' || variant === 'rail')
  const [expanded, setExpanded] = useState(initialExpanded)
  const [showAll, setShowAll] = useState(false)

  const tasks = useMemo(() => {
    const aggregated = aggregateTasks(toolCalls)
    if (!aggregated) return null
    // 稳定排序：同状态保持原插入顺序，进行中的任务始终置顶
    return aggregated
      .map((task, idx) => ({ task, idx }))
      .sort((a, b) => statusRank(a.task.status) - statusRank(b.task.status) || a.idx - b.idx)
      .map((x) => x.task)
  }, [toolCalls])

  if (!tasks || tasks.length === 0) return null

  const doneCount = tasks.filter((t) => isDone(t.status)).length
  const activeCount = tasks.filter((t) => isActive(t.status)).length

  const hiddenCount = showAll ? 0 : Math.max(0, tasks.length - COLLAPSED_LIMIT)
  const visibleTasks = hiddenCount > 0 ? tasks.slice(0, COLLAPSED_LIMIT) : tasks

  const taskList = (
    <>
      <ul className={styles.taskList}>
        {visibleTasks.map((task, idx) => (
          <li
            key={String(task.id ?? idx)}
            className={`${styles.taskItem} ${statusClass(task.status)}`}
          >
            <span className={styles.taskIcon}>{statusIcon(task.status)}</span>
            <span className={styles.taskSubject}>{task.subject ?? '（无标题）'}</span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          className={styles.showMore}
          onClick={() => setShowAll(true)}
        >
          还有 {hiddenCount} 项，展开全部
        </button>
      )}
    </>
  )

  /** 对话流内：轻量可折叠任务卡 */
  if (variant === 'inline') {
    return (
      <div className={styles.inlineCard}>
        <button
          type="button"
          className={styles.inlineHeader}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? '收起任务列表' : '展开任务列表'}
        >
          <span className={clsx(styles.inlineChevron, expanded && styles.inlineChevronOpen)}>
            ▾
          </span>
          <span className={styles.inlineTitle}>任务进度</span>
          <span className={styles.inlineStats}>
            {activeCount > 0 && (
              <span className={styles.inlineStatActive}>{activeCount} 进行中</span>
            )}
            <span className={styles.inlineCount}>{doneCount}/{tasks.length}</span>
          </span>
        </button>
        {expanded && taskList}
      </div>
    )
  }

  /** 左侧轨道：常驻展开的任务进度卡 */
  if (variant === 'rail') {
    return (
      <div className={styles.railCard}>
        <div className={styles.railHeader}>
          <span className={styles.railHeaderIcon} aria-hidden>◈</span>
          <span className={styles.railTitle}>任务进度</span>
          <span className={styles.railCount}>{doneCount}/{tasks.length}</span>
        </div>
        {taskList}
      </div>
    )
  }

  /** 紧凑模式：小图标触发器 + 悬停弹出层 */

  if (compact) {
    return (
      <div className={styles.compactWrap}>
        <button
          type="button"
          className={styles.compactTrigger}
          aria-label={`任务列表 ${doneCount}/${tasks.length}`}
          title={`任务列表 ${doneCount}/${tasks.length}${activeCount > 0 ? `，${activeCount} 进行中` : ''}`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          <span className={clsx(styles.compactBadge, activeCount > 0 && styles.compactBadgeActive)}>
            {doneCount}/{tasks.length}
          </span>
        </button>
        <div className={styles.compactPopover} role="region" aria-label="任务列表">
          <div className={styles.compactPopoverInner}>
            <div className={styles.compactPopoverHeader}>
              <span>任务列表</span>
              <span className={styles.compactPopoverStats}>
                {activeCount > 0 && <span className={styles.statActive}>{activeCount} 进行中</span>}
                <span className={styles.statCount}>{doneCount}/{tasks.length}</span>
              </span>
            </div>
            {taskList}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={styles.headerIcon}>◉</span>
        <span className={styles.headerTitle}>任务列表</span>
        <span className={styles.headerStats}>
          {activeCount > 0 && <span className={styles.statActive}>{activeCount} 进行中</span>}
          <span className={styles.statCount}>{doneCount}/{tasks.length}</span>
        </span>
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}>▾</span>
      </button>
      {expanded && taskList}
    </div>
  )
}

export default TodoPanel
