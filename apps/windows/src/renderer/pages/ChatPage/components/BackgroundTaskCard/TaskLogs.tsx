/**
 * 后台任务日志面板。
 *
 * 默认收起。展开后按级别过滤，并用固定行高做窗口虚拟滚动，避免上百条日志一次挂到 DOM。
 * 复制写出当前过滤结果的 JSON。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskLog, TaskLogLevel } from '../../../../../shared/agent-runtime-events'
import styles from './TaskLogs.module.css'

export interface TaskLogsProps {
  logs?: readonly TaskLog[]
  /** 可视区域高度（px） */
  maxHeight?: number
  /** 有 warn/error 时由父级传入 true，默认展开 */
  defaultExpanded?: boolean
}

const ITEM_HEIGHT = 24
const OVERSCAN = 6

const LEVEL_LABEL: Record<TaskLogLevel, string> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
}

/** 把当前过滤结果序列化成 JSON，供复制 */
export function serializeLogs(logs: readonly TaskLog[]): string {
  return JSON.stringify(logs)
}

/** 计算虚拟窗口。scrollTop 为容器滚动偏移 */
export function visibleLogRange(
  length: number,
  scrollTop: number,
  maxHeight: number,
): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN)
  const count = Math.ceil(maxHeight / ITEM_HEIGHT) + OVERSCAN * 2
  return { start, end: Math.min(length, start + count) }
}

/** 日志面板：展开、过滤、虚拟滚动、复制 JSON */
export const TaskLogs: React.FC<TaskLogsProps> = ({
  logs = [],
  maxHeight = 200,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [filterLevel, setFilterLevel] = useState<TaskLogLevel | 'all'>('all')
  const [scrollTop, setScrollTop] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // 后到的 warn/error：父级把 defaultExpanded 升为 true 时自动展开
  useEffect(() => {
    if (defaultExpanded) setExpanded(true)
  }, [defaultExpanded])

  const filteredLogs = useMemo(
    () => (filterLevel === 'all' ? logs : logs.filter((log) => log.level === filterLevel)),
    [logs, filterLevel],
  )

  const levelCounts = useMemo(() => ({
    debug: logs.filter((log) => log.level === 'debug').length,
    info: logs.filter((log) => log.level === 'info').length,
    warn: logs.filter((log) => log.level === 'warn').length,
    error: logs.filter((log) => log.level === 'error').length,
  }), [logs])

  const range = visibleLogRange(filteredLogs.length, scrollTop, maxHeight)
  const visibleLogs = filteredLogs.slice(range.start, range.end)

  useEffect(() => {
    const el = containerRef.current
    if (!expanded || !el) return
    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
  }, [expanded, filteredLogs.length])

  if (logs.length === 0) return null

  /** 复制当前过滤后的日志 JSON */
  const handleCopy = (): void => {
    const text = serializeLogs(filteredLogs)
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text)
      return
    }
    // 测试和旧环境没有 clipboard API 时，留给调用方通过选中文本处理
  }

  return (
    <div className={styles.container}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>日志 ({logs.length} 条)</span>
        <span aria-hidden="true">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className={styles.content}>
          <div className={styles.filters}>
            {(['all', 'debug', 'info', 'warn', 'error'] as const).map((level) => (
              <button
                key={level}
                type="button"
                className={filterLevel === level ? styles.filterActive : styles.filter}
                onClick={() => {
                  setFilterLevel(level)
                  setScrollTop(0)
                }}
              >
                {level === 'all' ? '全部' : `${LEVEL_LABEL[level]} (${levelCounts[level]})`}
              </button>
            ))}
            <button type="button" className={styles.copy} onClick={handleCopy}>
              复制
            </button>
          </div>
          <div
            ref={containerRef}
            className={styles.viewport}
            style={{ maxHeight }}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            {filteredLogs.length === 0 ? (
              <div className={styles.empty}>无日志</div>
            ) : (
              <div style={{ height: filteredLogs.length * ITEM_HEIGHT }}>
                <div style={{ transform: `translateY(${range.start * ITEM_HEIGHT}px)` }}>
                  {visibleLogs.map((log, index) => (
                    <div
                      key={`${log.timestamp}-${range.start + index}`}
                      className={`${styles.entry} ${styles[log.level]}`}
                      title={log.message}
                      style={{ height: ITEM_HEIGHT }}
                    >
                      <span className={styles.time}>
                        {new Date(log.timestamp).toLocaleTimeString('zh-CN')}
                      </span>
                      <span className={styles.level}>{log.level}</span>
                      <span className={styles.message}>{log.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
