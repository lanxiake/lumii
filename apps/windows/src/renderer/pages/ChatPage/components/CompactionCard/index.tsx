import React, { useState } from 'react'
import styles from './CompactionCard.module.css'

interface CompactionCardProps {
  tokensBefore: number
  tokensAfter: number
  messagesRemoved: number
  messagesBefore?: number
  messagesAfter?: number
}

const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

/**
 * 上下文压缩卡片 —— 以「工具调用」式的紧凑折叠卡片，在对话流中标记一次上下文压缩。
 * 数据来自 RuntimeCompactionEvent（自动压缩与手动压缩共用 agent:context:compacted 事件）。
 */
const CompactionCard: React.FC<CompactionCardProps> = ({
  tokensBefore,
  tokensAfter,
  messagesRemoved,
  messagesBefore,
  messagesAfter,
}) => {
  const [expanded, setExpanded] = useState(false)
  const savedK = Math.max(0, Math.round((tokensBefore - tokensAfter) / 1000))

  return (
    <div className={styles.card}>
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
        <span className={styles.summary}>
          释放约 {savedK}K tokens · 删除 {messagesRemoved} 条消息
        </span>
        <span className={styles.chevron}>
          {expanded
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          }
        </span>
      </button>
      {expanded && (
        <div className={styles.detail}>
          <div className={styles.detailRow}>
            <span>Tokens</span>
            <span>
              {fmtK(tokensBefore)} → {fmtK(tokensAfter)}
            </span>
          </div>
          {typeof messagesBefore === 'number' && typeof messagesAfter === 'number' && (
            <div className={styles.detailRow}>
              <span>消息数</span>
              <span>
                {messagesBefore} → {messagesAfter}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default CompactionCard
export { CompactionCard }
