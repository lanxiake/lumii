/**
 * ActivityFold — 执行过程折叠块（Cursor 式）
 * 把「思考 + 工具调用 + 中间文本」折叠进一行「执行过程」，最终答案留在折叠块外。
 * 默认折叠：流式中头部显示实时状态（正在思考 / 正在执行 grep...），
 * 完成后显示静态摘要（💭 思考 · 读取 3 个文件 · 搜索 2 次 + 耗时）。
 * 交互清晰化：左侧旋转 chevron + 「执行过程」标签 + 展开/收起提示文字。
 */

import React, { useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Loader2 } from 'lucide-react'
import styles from './ActivityFold.module.css'

export interface ActivityFoldProps {
  /** 完成后的静态摘要文案（如「💭 思考 · 读取 3 个文件」） */
  summary: string
  /** 流式中的实时状态短句（如「正在执行 grep…」）；非流式时为空 */
  currentStatus?: string
  /** 本轮是否流式进行中 */
  isStreaming: boolean
  /** 完成后的耗时（毫秒），仅非流式且 >0 时展示 */
  durationMs?: number
  /** 展开体：按时间线渲染的过程单元 */
  children: React.ReactNode
}

/** 把毫秒格式化为「1.2s」/「350ms」 */
function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

/** 折叠中间过程，仅露出一行「执行过程」摘要/状态 */
const ActivityFold: React.FC<ActivityFoldProps> = ({
  summary,
  currentStatus,
  isStreaming,
  durationMs,
  children,
}) => {
  const [expanded, setExpanded] = useState(false)

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
          <span className={styles.status}>{currentStatus || '正在处理…'}</span>
        ) : (
          <span className={styles.summary}>{summary}</span>
        )}
        {!isStreaming && durationMs !== undefined && durationMs > 0 && (
          <span className={styles.duration}>{formatDuration(durationMs)}</span>
        )}
        <span className={styles.hint}>{expanded ? '收起' : '展开'}</span>
      </button>
      {expanded && <div className={styles.body}>{children}</div>}
    </div>
  )
}

export default ActivityFold
export { ActivityFold }
