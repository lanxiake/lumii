/**
 * 对话内搜索条（Ctrl+F）。
 *
 * 只搜当前会话、纯内存——消息列表就在手上（含刚流出未落库的那几条），
 * 逐字响应没有成本。跨会话找「哪句话在哪个会话」是侧栏搜索的活。
 */
import React, { useCallback, useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import styles from './ChatSearchBar.module.css'

export interface ChatSearchBarProps {
  open: boolean
  query: string
  /** 命中条数 / 位置（0-based；-1 = 没有结果） */
  matchCount: number
  activeIndex: number
  onQueryChange: (value: string) => void
  onStep: (direction: 1 | -1) => void
  onClose: () => void
}

export const ChatSearchBar: React.FC<ChatSearchBarProps> = ({
  open,
  query,
  matchCount,
  activeIndex,
  onQueryChange,
  onStep,
  onClose,
}) => {
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开即聚焦并全选：再按一次 Ctrl+F 就是「换一个词」的常见动作
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        onStep(event.shiftKey ? -1 : 1)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    },
    [onStep, onClose],
  )

  if (!open) return null

  const label = !query.trim()
    ? ''
    : matchCount === 0
      ? '无结果'
      : `${activeIndex + 1}/${matchCount}`

  return (
    <div className={styles.bar} role="search">
      <input
        ref={inputRef}
        type="search"
        className={styles.input}
        value={query}
        placeholder="在当前对话里搜索…"
        aria-label="在当前对话里搜索"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className={styles.count} aria-live="polite">
        {label}
      </span>
      <button
        type="button"
        className={styles.navBtn}
        onClick={() => onStep(-1)}
        disabled={matchCount === 0}
        title="上一个（Shift+Enter）"
        aria-label="上一个匹配"
      >
        <ChevronUp size={14} strokeWidth={2} />
      </button>
      <button
        type="button"
        className={styles.navBtn}
        onClick={() => onStep(1)}
        disabled={matchCount === 0}
        title="下一个（Enter）"
        aria-label="下一个匹配"
      >
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      <button
        type="button"
        className={styles.navBtn}
        onClick={onClose}
        title="关闭（Esc）"
        aria-label="关闭搜索"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}
