import React, { useState } from 'react'
import clsx from 'clsx'
import styles from './CompactionCard.module.css'

interface CompactionCardProps {
  tokensBefore: number
  tokensAfter: number
  messagesRemoved: number
  messagesBefore?: number
  messagesAfter?: number
  /** LLM 摘要正文，展开后展示 */
  summaryText?: string
}

const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

/**
 * 上下文压缩卡片 —— 对话流中标记一次压缩，可展开查看 token 变化与摘要正文。
 */
const CompactionCard: React.FC<CompactionCardProps> = ({
  tokensBefore,
  tokensAfter,
  messagesRemoved,
  messagesBefore,
  messagesAfter,
  summaryText,
}) => {
  const [expanded, setExpanded] = useState(false)
  const hasTokenDelta = tokensBefore > 0
  const savedK = hasTokenDelta ? Math.max(0, Math.round((tokensBefore - tokensAfter) / 1000)) : 0
  const headerHint = hasTokenDelta
    ? `释放约 ${savedK}K tokens · 删除 ${messagesRemoved} 条消息`
    : summaryText
      ? '点击查看压缩摘要'
      : '已压缩对话历史'

  return (
    <div className={clsx(styles.card, expanded && styles.cardExpanded)}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={styles.icon}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8l4-4 4 4M3 16l4 4 4-4M17 4v16M7 4v16" />
          </svg>
        </span>
        <span className={styles.title}>上下文压缩</span>
        <span className={styles.summary}>{headerHint}</span>
        <span className={styles.chevron}>
          {expanded
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          }
        </span>
      </button>
      {expanded && (
        <div className={styles.detail}>
          {hasTokenDelta && (
            <div className={styles.detailRow}>
              <span>整窗占用</span>
              <span>
                {fmtK(tokensBefore)} → {fmtK(tokensAfter)}
              </span>
            </div>
          )}
          {typeof messagesBefore === 'number' && typeof messagesAfter === 'number' && (
            <div className={styles.detailRow}>
              <span>消息数</span>
              <span>
                {messagesBefore} → {messagesAfter}
              </span>
            </div>
          )}
          {summaryText ? (
            <pre className={styles.summaryBody}>{summaryText}</pre>
          ) : (
            <p className={styles.summaryEmpty}>本次压缩未生成可读摘要</p>
          )}
        </div>
      )}
    </div>
  )
}

export default CompactionCard
export { CompactionCard }
