/**
 * ActivityFold — 执行过程折叠块（Cursor 式）
 * 把「思考 + 工具调用 + 中间文本」折叠进一行「执行过程」，最终答案留在折叠块外。
 * 默认折叠：流式中头部显示进度（任务 3/8 / 5/12 步），折叠态下方再露最多 3 行
 * 「迷你活动流」（最新思考预览 + 最近完成步骤 + 正在执行的命令），避免长任务一无所知；
 * 完成后收起为静态摘要（思考 · 读取 3 个文件 · 搜索 2 次 + 耗时）。
 * 交互清晰化：左侧旋转 chevron + 「执行过程」标签 + 展开/收起提示文字。
 */

import React, { useState, useEffect, useRef } from 'react'
import clsx from 'clsx'
import { ChevronRight, Loader2, Check, Brain, AlertTriangle, Ban } from 'lucide-react'
import styles from './ActivityFold.module.css'

/** 折叠态活动流的一行（由 ChatMessage 从过程单元压平而来） */
export interface ActivityLine {
  key: string
  kind: 'thinking' | 'tool'
  status: 'running' | 'done' | 'failed' | 'interrupted'
  /** 展示文案：思考预览 / 工具动作短句 */
  text: string
}

/** 折叠态头部进度：task=任务列表完成度，step=执行步骤进度 */
export interface ActivityProgress {
  done: number
  total: number
  kind: 'task' | 'step'
}

interface ActivityFoldProps {
  /** 完成后的静态摘要文案（如「💭 思考 · 读取 3 个文件」） */
  summary: string
  /** 流式中的实时状态短句（如「正在执行 grep…」）；无 progress 时的回退展示 */
  currentStatus?: string
  /** 本轮是否流式进行中 */
  isStreaming: boolean
  /** 完成后的耗时（毫秒），仅非流式且 >0 时展示 */
  durationMs?: number
  /** 流式开始时间（用于实时计时器） */
  startTime?: Date
  /** 折叠态活动流（仅流式时展示，最多 3 行，最新在最后） */
  activityLines?: readonly ActivityLine[]
  /** 折叠态头部进度（优先于 currentStatus 展示） */
  progress?: ActivityProgress
  /** 展开体：按时间线渲染的过程单元 */
  children: React.ReactNode
}

/** 把毫秒格式化为「1.2s」/「350ms」 */
function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

/** 进度文案：任务列表口径 vs 步骤口径 */
function formatProgress(progress: ActivityProgress): string {
  return progress.kind === 'task'
    ? `任务 ${progress.done}/${progress.total}`
    : `${progress.done}/${progress.total} 步`
}

/** 活动流左侧图标：运行中旋转、失败/中断用告警，其余按思考/工具区分 */
function ActivityIcon({ line }: { line: ActivityLine }) {
  if (line.status === 'running') {
    return <Loader2 size={12} className={styles.feedSpinner} aria-hidden />
  }
  if (line.status === 'failed') {
    return <AlertTriangle size={12} aria-hidden />
  }
  if (line.status === 'interrupted') {
    return <Ban size={12} aria-hidden />
  }
  return line.kind === 'thinking'
    ? <Brain size={12} aria-hidden />
    : <Check size={12} aria-hidden />
}

/** 折叠中间过程，仅露出「执行过程」摘要/状态；流式时额外露出迷你活动流 */
const ActivityFold: React.FC<ActivityFoldProps> = ({
  summary,
  currentStatus,
  isStreaming,
  durationMs,
  startTime,
  activityLines,
  progress,
  children,
}) => {
  const [expanded, setExpanded] = useState(false)
  // 流式进行中的实时计时器（秒）
  const [liveElapsedSec, setLiveElapsedSec] = useState(0)
  const feedRef = useRef<HTMLUListElement>(null)

  // 流式中每秒更新 liveElapsedSec
  useEffect(() => {
    if (!isStreaming || !startTime) {
      setLiveElapsedSec(0)
      return
    }
    const initial = Math.floor((Date.now() - startTime.getTime()) / 1000)
    setLiveElapsedSec(initial)

    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000)
      setLiveElapsedSec(elapsed)
    }, 1000)

    return () => clearInterval(timer)
  }, [isStreaming, startTime])

  // 活动流始终滚到最新（新增行时）
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight
    }
  }, [activityLines])

  // 展示的耗时文本
  const displayedDuration = isStreaming
    ? formatDuration(liveElapsedSec * 1000)
    : durationMs !== undefined && durationMs > 0
      ? formatDuration(durationMs)
      : null

  const showFeed = isStreaming && !expanded && !!activityLines && activityLines.length > 0
  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0

  return (
    <div className={clsx(styles.fold, isStreaming && styles['fold--streaming'])}>
      <button
        type="button"
        className={clsx(styles.header, expanded && styles['header--expanded'])}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={expanded ? '收起执行过程' : '展开查看执行过程'}
      >
        <ChevronRight
          size={14}
          className={clsx(styles.chevron, expanded && styles['chevron--open'])}
          aria-hidden
        />
        <span className={styles.label}>
          {isStreaming && <Loader2 size={12} className={styles.spinner} aria-hidden />}
          执行过程
        </span>
        {isStreaming ? (
          progress ? (
            <span className={styles.progressText}>{formatProgress(progress)}</span>
          ) : (
            <span className={styles.status}>{currentStatus || '正在处理…'}</span>
          )
        ) : (
          <span className={styles.summary}>{summary}</span>
        )}
        {displayedDuration && (
          <span className={styles.duration}>{displayedDuration}</span>
        )}
        <span className={styles.hint}>{expanded ? '收起' : '展开'}</span>
      </button>
      {showFeed && (
        <div
          className={styles.feed}
          onClick={() => setExpanded(true)}
          title="点击展开查看完整执行过程"
          data-testid="activity-feed"
        >
          <ul className={styles.feedList} ref={feedRef}>
            {activityLines.map((line) => (
              <li
                key={line.key}
                className={clsx(styles.feedLine, styles[`feedLine--${line.status}`])}
                data-testid="activity-line"
              >
                <span className={styles.feedIcon}><ActivityIcon line={line} /></span>
                <span className={styles.feedText}>{line.text}</span>
              </li>
            ))}
          </ul>
          {progress && progress.total > 0 && (
            <div
              className={styles.progressBar}
              role="progressbar"
              aria-valuenow={progress.done}
              aria-valuemin={0}
              aria-valuemax={progress.total}
            >
              <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
            </div>
          )}
        </div>
      )}
      {expanded && (
        <div className={styles.body}>
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

export { ActivityFold }
